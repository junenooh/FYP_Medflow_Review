const RECOMMENDATION_LABELS = {
  Strong: "Best Bundle",
  Moderate: "Recommended Bundle",
  Weak: "Consider Bundle",
};

export function recommendationLabel(strength) {
  return RECOMMENDATION_LABELS[strength] || strength || "—";
}

function metricValue(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function thresholdLabel(value, bands) {
  const number = metricValue(value);
  if (number == null) return "—";
  return bands.find(([minimum]) => number >= minimum)?.[1] ?? bands.at(-1)[1];
}

export function confidenceLabel(value) {
  return thresholdLabel(value, [
    [0.7, "Highly Reliable"],
    [0.6, "Reliable"],
    [0.5, "Moderately Reliable"],
    [Number.NEGATIVE_INFINITY, "Unreliable"],
  ]);
}

export function supportLabel(value) {
  return thresholdLabel(value, [
    [0.05, "Very Common"],
    [0.03, "Common"],
    [0.02, "Less Common"],
    [Number.NEGATIVE_INFINITY, "Uncommon"],
  ]);
}

export function liftLabel(value) {
  const number = metricValue(value);
  if (number == null) return "—";
  return number >= 1.2 ? "Truly Associated" : "Coincidental";
}
