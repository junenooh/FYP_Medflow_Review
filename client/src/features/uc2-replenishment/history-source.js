/**
 * Which history the History tab and the product panel show: the live history of the subsidiary on
 * screen (history-data.js) once it has loaded, otherwise the analytical sample (sample-history.js).
 * Both expose the same interface: HISTORY, HISTORY_DAYS, dayDate, periodMetrics, getSkuHistory.
 */

import * as sample from "./sample-history.js";

export const SAMPLE_HISTORY = Object.freeze({
  live: false,
  HISTORY: sample.HISTORY,
  HISTORY_DAYS: sample.HISTORY_DAYS,
  dayDate: sample.dayDate,
  periodMetrics: sample.periodMetrics,
  getSkuHistory: sample.getSkuHistory,
});

let active = SAMPLE_HISTORY;

export const historySource = () => active;

export function useHistorySource(source) {
  active = source || SAMPLE_HISTORY;
}
