export const ACCESS_MODEL = Object.freeze({
  zoneMetres: 40,
  aisleMetres: 3,
  tripFactor: 2,
  walkingSpeed: 1.4,
  ladderPenalty: 20,
});

function signatureValues(signature) {
  return Object.fromEntries(String(signature || "")
    .split("|")
    .slice(1)
    .map((part) => {
      const index = part.indexOf("=");
      return index === -1 ? null : [part.slice(0, index), part.slice(index + 1)];
    })
    .filter(Boolean));
}

function numberFromSignature(values, key) {
  const value = Number(values[key]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The UC3 engine persists aggregate, run-specific travel totals in its model
 * signature. Prefer them for Picker Travel Impact: unlike a browser-side
 * approximation, they include each product group, measured UC2 demand and
 * the saved engine assumptions used to approve the moves.
 */
export function savedRunTravelMetrics(run) {
  const values = signatureValues(run?.parametersignature);
  const currentSeconds = numberFromSignature(values, "current_s");
  const recommendedSeconds = numberFromSignature(values, "proposed_s");
  const savedSeconds = numberFromSignature(values, "saved_s");
  const productsMoved = numberFromSignature(values, "moved");
  const binsMoved = numberFromSignature(values, "bins_moved");
  if (![currentSeconds, recommendedSeconds, savedSeconds, productsMoved, binsMoved].every((value) => value !== null)
    || currentSeconds <= 0 || recommendedSeconds < 0 || savedSeconds < 0) return null;

  const model = {
    zoneMetres: numberFromSignature(values, "zone_m") ?? ACCESS_MODEL.zoneMetres,
    aisleMetres: numberFromSignature(values, "aisle_m") ?? ACCESS_MODEL.aisleMetres,
    tripFactor: numberFromSignature(values, "trip") ?? ACCESS_MODEL.tripFactor,
    walkingSpeed: numberFromSignature(values, "speed") ?? ACCESS_MODEL.walkingSpeed,
    ladderPenalty: numberFromSignature(values, "ladder_s") ?? ACCESS_MODEL.ladderPenalty,
  };
  const reductionSeconds = Math.max(0, currentSeconds - recommendedSeconds);
  // Keep the saved value as the authority for weekly benefit. The equality is
  // checked by the engine when the run is written; the computed reduction is
  // used only to protect against a malformed signature.
  const verifiedSavedSeconds = Math.abs(reductionSeconds - savedSeconds) < 1 ? savedSeconds : reductionSeconds;
  return {
    source: "saved-run",
    unit: "daily-picker-time",
    current: { average: currentSeconds, secondsPerDay: currentSeconds, hoursPerDay: currentSeconds / 3600 },
    recommended: { average: recommendedSeconds, secondsPerDay: recommendedSeconds, hoursPerDay: recommendedSeconds / 3600 },
    improvementPct: reductionSeconds / currentSeconds,
    dailyHoursSaved: verifiedSavedSeconds / 3600,
    weeklyHoursSaved: (verifiedSavedSeconds * 7) / 3600,
    productsMoved,
    binsMoved,
    model,
  };
}

export function slotAccess(bin, model = ACCESS_MODEL) {
  const zoneIndex = Math.max(0, Number(bin?.zoneIdx) || 0);
  const aisle = Math.max(1, Number(bin?.aisle) || 1);
  const distance = zoneIndex * model.zoneMetres + (aisle - 1) * model.aisleMetres;
  const shelfPenalty = bin?.accessRequirement === "LADDER" ? model.ladderPenalty : 0;
  return {
    distance,
    shelfPenalty,
    seconds2d: (model.tripFactor * distance) / model.walkingSpeed,
    seconds25d: (model.tripFactor * distance) / model.walkingSpeed + shelfPenalty,
  };
}

function demandFor(sku, move) {
  if (move?.avgdailydemand) return Number(move.avgdailydemand);
  return { A: 54, B: 28, C: 12 }[sku?.velocityclass] || 8;
}

export function buildScenarios(bins, moves) {
  const current = Object.fromEntries(bins.filter((bin) => bin.sku).map((bin) => [bin.sku.productid, bin.binid]));
  const recommended = { ...current };

  moves.forEach((move) => {
    recommended[move.productid] = move.recommendedbin;
  });

  return { current, recommended };
}

export function scenarioMetrics(bins, moves, scenarios, use25d = true) {
  const binById = Object.fromEntries(bins.map((bin) => [bin.binid, bin]));
  const skuById = Object.fromEntries(bins.filter((bin) => bin.sku).map((bin) => [bin.sku.productid, bin.sku]));
  const moveBySku = Object.fromEntries(moves.map((move) => [move.productid, move]));
  const score = (layout) => {
    let weightedSeconds = 0;
    let picks = 0;
    Object.entries(layout).forEach(([skuId, binId]) => {
      const bin = binById[binId];
      if (!bin) return;
      const demand = demandFor(skuById[skuId], moveBySku[skuId]);
      weightedSeconds += demand * slotAccess(bin)[use25d ? "seconds25d" : "seconds2d"];
      picks += demand;
    });
    return { average: picks ? weightedSeconds / picks : 0, picks, weightedSeconds };
  };

  const current = score(scenarios.current);
  const recommended = score(scenarios.recommended);
  const savedSeconds = Math.max(0, current.weightedSeconds - recommended.weightedSeconds);
  return {
    current,
    recommended,
    improvementPct: current.average ? Math.max(0, (current.average - recommended.average) / current.average) : 0,
    weeklyHoursSaved: (savedSeconds * 7) / 3600,
  };
}

export function enrichMoves(moves, bins, use25d = true) {
  const binById = Object.fromEntries(bins.map((bin) => [bin.binid, bin]));
  return moves.map((move) => {
    const from = slotAccess(binById[move.currentbin]);
    const to = slotAccess(binById[move.recommendedbin]);
    const key = use25d ? "seconds25d" : "seconds2d";
    const calculatedSaving = Math.max(0, from[key] - to[key]);
    // New UC3 runs persist this per-bin figure. Historical runs remain
    // readable by falling back to the same client-side calculation.
    const hasPersistedSaving = move.timesavedseconds !== null
      && move.timesavedseconds !== undefined
      && Number.isFinite(Number(move.timesavedseconds));
    const saving = hasPersistedSaving
      ? Math.max(0, Number(move.timesavedseconds))
      : calculatedSaving;
    return {
      ...move,
      currentSeconds: from[key],
      recommendedSeconds: to[key],
      savingSeconds: saving,
      improvementPct: from[key] ? saving / from[key] : Number(move.distanceimprovementpct || 0),
      fromShelf: binById[move.currentbin]?.shelfLevel || "—",
      toShelf: binById[move.recommendedbin]?.shelfLevel || "—",
    };
  });
}
