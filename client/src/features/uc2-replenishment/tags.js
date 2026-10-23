import { escapeHtml } from "@shared/utils/html.js";

export const LINK_ICON = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`;

/** A SKU that travels in someone else's order because UC1 found it is often ordered with the trigger. */
export const companionTag = (text = "Companion") => `<span class="co-tag">${LINK_ICON}${escapeHtml(text)}</span>`;

/** The SKU that reached its reorder point and raised the order. */
export const triggerTag = () =>
  `<span class="co-tag is-trigger" title="This item reached its reorder point, so a restock was ordered">Ran low</span>`;

/** "1 companion" / "3 companions" */
export const companionCount = (count) => `${count} ${count === 1 ? "companion" : "companions"}`;
