const READY_STATES = new Set(["ready", "zero-changes"]);

export function recommendationIsReady(current, result) {
  return Boolean(current?.ok && current?.layout && result?.ok && READY_STATES.has(result.state));
}

/** Explains whether the selected persisted recommendation can power UC3 analysis. */
export function analyticsTabAvailability(current, result, { checking = false } = {}) {
  if (checking) return { ready: false, message: "Checking recommended layout…" };
  if (recommendationIsReady(current, result)) {
    return { ready: true, message: "Product Moves and Picker Travel Impact are available for the selected recommended layout." };
  }
  if (result?.state === "no-run") {
    return { ready: false, message: "Generate a recommended layout to view Product Moves and Picker Travel Impact." };
  }
  if (["invalid", "incomplete-run"].includes(result?.state)) {
    return { ready: false, message: "Select or generate a valid recommended layout to view analysis." };
  }
  return { ready: false, message: "Recommended layout could not be verified. Retry the layout view." };
}

/** Never permit an unavailable analytical deep link to render an empty analysis page. */
export function resolvedUc3Tab(requestedTab, availability) {
  return requestedTab !== "map" && !availability.ready ? "map" : requestedTab;
}
