# UC2 Traceability — User Stories → Test Cases

Links every UC2 user story's acceptance criteria (AC) to the unit tests (`TC-UC2-UT-xxx`), the policy data verification
(`TC-UC2-DV-xxx`), both in `uc2-unit-tests.md`, and the functional tests (`TC-UC2-FT-xxx`, `uc2-functional-tests.md`).

**Last updated:** 2026-10-19. Story IDs and acceptance criteria are taken from the *User Stories* tab of the Product
Backlog & Sprint Review sheet.

**Test levels:** the policy maths (US2.1, US2.2) is covered by engine unit tests, page-logic unit tests and a check of
every stored policy row; the page stories (UC2.4, UC2.5) by functional tests; the ordering story (US2.3) by all three.

**Coverage status key**

- **Covered** — a test checks this AC directly.
- **Partial** — part of the AC is tested; the rest is noted.
- **Not covered** — no test yet.
- **Not implemented** — no code for this AC was found in the repository, so it cannot pass a test yet.
- **Mismatch** — the AC and the code disagree; the team needs to decide which one is correct.
- **Scope note** — the AC states an assumption or the project's scope, not behaviour that can be tested.

## User stories

| ID | User story (short) | Sprint | Owner |
|---|---|---|---|
| US2.1 | Calculate demand and replenishment policy values for each subsidiary-SKU | Sprint 2 | Jeremiah |
| US2.2 | Identify SKUs that reached their reorder point and calculate the restock quantity | Sprint 3 | Jeremiah |
| US2.3 | Automatic restocks, with UC1 companions shown beside each recommendation | Sprint 3 | Jun En |
| UC2.4 | Group statuses and recommendations so it is clear what needs attention | Sprint 3 | Jun En |
| UC2.5 | Business-friendly language and visuals on the replenishment dashboard | Sprint 4 | Jun En |

## Acceptance criteria → test cases

| Story | AC | Acceptance criterion (short) | Test cases | Status | Notes |
|---|---|---|---|---|---|
| US2.1 | 1 | Average Daily Demand from subsidiary consumption, configurable history days, 30 by default | UT-012, UT-015, DV-005 | Mismatch | Daily demand is forecast with exponential smoothing (smooth items) or Syntetos–Boylan (intermittent, lumpy, erratic) over a 365-day classification window, not a 30-day average. A plain average over a chosen window exists only as the dashboard's "simple" preview. Update the AC to the forecasting method, or the code |
| US2.1 | 2 | Calculate z-score, lead-time demand variability, safety stock, ROP, EOQ and OUTL | UT-011, UT-013, UT-014, DV-002, DV-003, DV-004, DV-007 | Partial | z (per product service level), lead-time variability (σ_LT in the safety-stock formula), safety stock, reorder point and order-up-to level are calculated and verified on all 5,000 rows. **EOQ is not calculated** |
| US2.1 | 3 | ROP is the threshold that triggers replenishment | DV-003, UT-101, UT-104, FT-005, FT-010 | Covered | |
| US2.1 | 4 | EOQ is the quantity ordered when the reorder point is reached | — | Mismatch | No EOQ exists. The quantity ordered is order-up-to level − inventory position (an (s, S) policy), rounded to whole cartons. Update the AC to match US2.2 AC4 |
| US2.1 | 5 | OUTL is the order-up-to level used to set the recommended quantity | DV-004, UT-104, FT-009, FT-010 | Covered | |
| US2.1 | 6 | Inputs, calculated values, units, run metadata and date are stored so a recommendation can be reproduced | DV-001, DV-007, FT-009 | Covered | Each policy row stores its inputs (ADI, CV², μ, σ, z, lead time, σ_LT, coverage, α), results, method, as-of date and computedat; settings changes are recorded in `uc2_settings_history`. Units are not stored as a column (all quantities are units of the product) |
| US2.1 | 7 | Quantities are rounded consistently by the unit-quantity rules | UT-105, DV-008, FT-010 | Covered | Whole cartons (`storage.shippingcasepack`): nearest to the quantity, never fewer than it takes to clear the reorder point |
| US2.2 | 1 | Inventory position is calculated for each subsidiary-SKU | UT-103, UT-104, FT-005 | Covered | The page counts on hand + units on open restocks. The database's own stored status uses on hand only (DV-006), from when deliveries were instant |
| US2.2 | 2 | Inventory position is compared with ROP to decide whether to restock | UT-101, UT-104, FT-005 | Covered | |
| US2.2 | 3 | Inventory position ≤ ROP triggers a recommendation | UT-101, UT-104, FT-010, FT-012 | Covered | |
| US2.2 | 4 | Recommended quantity = max(0, OUTL − inventory position) | UT-104, FT-010 | Covered | The units actually ordered are this quantity rounded to whole cartons (UT-105), so they can differ by part of a carton |
| US2.2 | 5 | Inventory position > ROP gives quantity 0 | UT-104, FT-011 | Covered | |
| US2.2 | 6 | Without consumption history, a documented fallback estimates demand and records the limitation | UT-012, UT-014, UT-102 | Partial | One demand day → "insufficient" (plain average); none → dormant (no reorder point); few demand days raise the low-confidence flag. The limitation is stored as the class and flag, but the page does not explain it to the planner |
| US2.2 | 7 | Discontinued products get quantity 0, if a discontinued status exists | — | Not implemented | `product.status` can be "Discontinued", but neither `uc2_calc` nor the nightly reorder check reads it. Every product is "Available" in the current data, so there is nothing to test yet |
| US2.3 | 1 | A product that reaches its reorder point is ordered automatically | DV-008, UT-106, FT-012, FT-015 | Covered | Orders are raised by the nightly reorder check (`scripts/live/day.py`, 23:30), which has no unit tests; its output is verified in the data and on the page |
| US2.3 | 2 | UC1 companions are only suggested, never reordered automatically | UT-107, FT-014 | Mismatch | The page only suggests companions. But the nightly reorder check now adds Strong and Moderate companions to the same order before they reach their own reorder point (the "can-order" rule; lines ending in "C"). The team should decide which rule stands |
| US2.3 | 3 | Central warehouse stock is assumed unlimited | — | Scope note | The reorder check tops central bins up from a supplier instantly, so central stock never limits an order |
| US2.3 | 4 | The orders table is updated, and subsidiary inventory is updated when a restock is delivered | UT-106, FT-012, FT-015, FT-017 | Partial | Order statuses (placed, on its way, delivered) and deliveries are shown correctly. The inventory update on delivery happens in `day.py` and is not tested directly |
| US2.3 | 5 | The system automates replenishment and reduces manual work | FT-010, FT-015 | Scope note | A design goal: restocks are raised nightly with no approval step |
| US2.3 | 6 | Scanning, dispatch, transport tracking and acceptance are not modelled | — | Scope note | |
| US2.3 | 7 | No real logistics data; shipment execution is out of scope | — | Scope note | |
| US2.3 | 8 | The focus is recommendations, automated ordering and decision support | — | Scope note | |
| UC2.4 | 1 | Each subsidiary shows the current quantity of every product | FT-001, FT-002, FT-005 | Covered | |
| UC2.4 | 2 | Each product shows its status (OOS / Low Stock / Near ROP / Available) | UT-101, FT-003, FT-004 | Covered | |
| UC2.4 | 3 | Out of stock when on hand ≤ 0 | UT-101, FT-005 | Covered | |
| UC2.4 | 4 | Low Stock at or below the reorder point, and it triggers a restock | UT-101, UT-104, FT-005, FT-010 | Covered | |
| UC2.4 | 5 | Near ROP is the safety-stock range above the reorder point and does not trigger a restock | UT-101, UT-104, FT-005, DV-006 | Covered | The page follows the AC (reorder point + safety stock). The database's stored status uses a different band (reorder point × 1.2), see DV-006; only the page's status is shown to planners |
| UC2.4 | 6 | Available is above the Near ROP band, with no action | UT-101, FT-011 | Covered | |
| UC2.4 | 7 | The UI shows subsidiary, SKU, stock level, status and restock action | FT-001, FT-003, FT-019 | Covered | |
| UC2.4 | 8 | Alerts and recommendations are linked to the relevant replenishment run | UT-108, FT-020, DV-001 | Partial | Alerts link to the subsidiary and products, and carry the policy's as-of day and computedat. UC2 writes no run ID (`modelrun`), so an alert cannot name a run |
| UC2.4 | 9 | Statuses can be filtered by status and subsidiary | FT-002, FT-004 | Covered | |
| UC2.5 | 1 | Key information is clear: warehouse, product, stock level, status, quantity and action | FT-001, FT-008, FT-010 | Covered | |
| UC2.5 | 2 | Technical terms (ROP, OUTL) are replaced by business labels; details stay available | FT-009, FT-022 | Partial | Reorder point and order-up-to level are spelled out, and the details sit under "How it's calculated". **Defect:** "Near ROP" still appears in the status chip, status column and legend (FT-022 fails) |
| UC2.5 | 3 | Formulas and calculations are hidden by default | FT-009 | Covered | |
| UC2.5 | 4 | Statuses read Out of Stock, Reorder Now, Near Reorder Level and Available | FT-023 | Mismatch | The page uses Out of stock, Low stock, Near ROP and In stock (FT-023 fails). Rename them, or update the AC |
| UC2.5 | 5 | A short plain-English reason for each recommendation | FT-008, FT-010, FT-012 | Covered | e.g. "At its reorder point of 125.", "Ordering tonight", "On its way · arrives 15 Oct" |
| UC2.5 | 6 | Important risks and actions are prioritised visually | UT-109, FT-006, FT-020, FT-021 | Covered | Most urgent first, the "Running low" shortcut, and the notification headline |
| UC2.5 | 7 | Filters are simple: warehouse and status | FT-002, FT-004 | Covered | |
| UC2.5 | 8 | UI changes do not affect the calculation | FT-027, DV-002, DV-003, DV-004 | Covered | |

## Summary

| Status | Number of ACs |
|---|---|
| Covered | 24 |
| Partial | 5 |
| Mismatch | 4 |
| Not implemented | 1 |
| Not covered | 0 |
| Scope note | 5 |
| **Total** | **39** |

Tests not tied to a story: UT-010, FT-024 and FT-025 (robustness checks).

## Decisions for the team

1. **US2.1 AC1 and AC4:** the code forecasts demand with SES / SBA over 365 days and orders up to the order-up-to level (no EOQ). Update the ACs, or change the code.
2. **US2.3 AC2:** the nightly reorder check now adds UC1 companions automatically, which the AC rules out. Decide which rule stands.
3. **UC2.5 AC2 and AC4 (defects FT-022, FT-023):** rename the statuses ("Low stock" → "Reorder now", "Near ROP" → "Near reorder level", "In stock" → "Available") and the legend, or update the AC.
4. **US2.2 AC7:** decide whether discontinued products should be excluded now that `product.status` supports it.
5. **UC2.4 AC8:** decide whether UC2 should record a run ID so alerts can name the run they came from.
6. **Two Near-ROP rules:** the database's stored status (ROP × 1.2) and the page's (ROP + safety stock) differ. Align them so exports and alerts never disagree.
