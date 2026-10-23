# UC2 — Replenishment

Route: `#/uc2` (tabs: `?tab=skus|orders|history`, subsidiary: `?warehouse=WH002`)

Presents the (s,S) continuous-review output for a subsidiary warehouse: which SKUs have reached their reorder point, how much to order from Central up to the Order Up To Level, and which UC1 companions are bundled in. The auditable policy belongs in `engines/uc2/replenishment.py`; the browser only filters and presents its output.

## Build phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Page skeleton: header, context strip, KPIs, tabs, sample banner | done |
| 2 | **Stock status** tab: auto-replenishment pipeline, status chips, five-column table with stock-level bar, days-left runway and auto-order state | done |
| 2b | **Detail drawer** (select a row): worked calculation with whole-carton rounding, stock-over-time step chart, auto-order progress | done |
| 3 | **Auto-orders** tab: stage board (Order placed, On its way, Delivered; newest 5 per column, View all) with a List toggle to a sortable, searchable, paginated order table with status filters; order detail drawer with progress and paginated lines (companions with UC1 strength and lift, whole-carton quantities) | done |
| 4 | **History** tab: period stat tiles with trends, SKU × day status calendar (with a table view), activity feed; a status-history card in the product panel | done |
| 6 | Real Supabase data: **Stock status** and **Auto-orders** read live UC2 output (`live-data.js`), with the sample as fallback. History reads the real last 90 days (`history-data.js`); Export CSV works on all three tabs | done |

## Rules this page follows

Source: `docs/use-cases/technical-documentation.md`, Use Case 2.

- **Orders are automatic.** When a SKU's inventory position is at or below its reorder point (s) the system raises the order itself, sized up to the order-up-to level (S). No approval step, so the UI never says "suggested" or "approve".
- **Status bands** (`replenishmentrecommendation.status`): Out of Stock (on hand <= 0, urgent alert), Low Stock (position <= ROP, regular alert), Near ROP (ROP < position <= ROP + safety stock, monitor, quantity 0 on its own), Available (OK).
- **Recommended quantity** = S − inventory position, never below 0.
- **Central has unlimited stock:** every order is filled in full, so there is no availability check, hold state or "Needs attention" stage.
- **Companions (advice only):** Strong and Moderate UC1 companions (`productrelationship`, read both ways) are shown beside each product: a "N companions" tag in the Stock status table and an "Often requested with this" section in the product panel, with each companion's own stock. When the product needs a restock, each companion is marked *Worth adding* (Near ROP), *Due as well* (at its own reorder point), *Already on order* or *Not needed*. Nothing is added to an order automatically; the analyst decides. The CSV export carries them in a "UC1 companions" column.
- **Whole cartons:** calculate in units, then round the order up to whole cartons (23 units at 10 per carton is 3 cartons). Lands in Phase 3.

## Data

`live-data.js` reads, for the selected subsidiary (read-only):

| Shown as | Source |
| --- | --- |
| Stock, reorder point, safety stock, order-up-to, daily use, days of cover | `uc2_policy_parameters` (UC2 engine output; not re-derived here) |
| Product names, carton size | `product`, `storage.shippingcasepack` |
| Auto-orders and units on their way | `orders` + `orderline` (latest 30). Fulfilled = delivered; an open order from the last day of data = placed; older open orders = on its way |
| Stock over time in the product panel | `inventory`, last 8 movements in the last 14 days |

Status follows the business rule on the **inventory position** (on hand + on its way): Out of Stock = nothing on hand, Low Stock = position ≤ ROP, Near ROP = ROP < position ≤ ROP + safety stock, Available above that. UC2's own `stockstatus` compares stock on hand only, so a SKU with enough already on its way would still read Low Stock there; the page does not use it.

Display arithmetic only: inventory position = on hand + on its way; recommended quantity = OUL − position for SKUs UC2 marks Low Stock (or with nothing on hand) whose position is still at or below the reorder point; cartons are rounded up. A breached SKU with no open order shows "Order due · raised at the next reorder check" until the reorder-check script exists.

The orders come from the simulation: the history used the starting (pre-UC2) policy, days added by `scripts/live/day.py` reorder on UC2's policy. Every line in them reached its own reorder point, so each line is a trigger and the drawer says "N SKUs at their reorder point" instead of "1 trigger + companions".

The read is cached once per page load in `live-data.js` (`loadLiveUc2`) and shared with the notification bell (`features/notifications`), which also uses UC2's `flag_*` columns. `?sku=MED0170` on the Stock status tab opens that product's panel.

If the read fails or UC2 has not run, the page falls back to `sample-data.js` and the banner says why.

**History** (`history-data.js`, loaded in the background per subsidiary): the last 90 days from `consumption` (closing stock per day), `orders` + `orderline`, and `warehouseproduct`. Each day's status uses the page's rule on stock + units on their way (an order counts from the day after it was raised, so the day it was raised shows Low). UC2 keeps only its current reorder points, so days up to the end of the simulated history (`scripts/sim/sim_config.json` `end_date`) are judged against the starting levels in `warehouseproduct`, the ones those orders were placed on, and later days against UC2's. If the read fails, the tab falls back to `sample-history.js` and says so.

Inventory rows are written only when quantity changes, so the page reads the latest snapshot per SKU–warehouse pair. Label it "snapshot" / "event-driven", never "live". Orders are subsidiary → Central only; do not use hospital or site language.

`status.js` holds the four persisted status values with their alert levels, urgency order and the auto-order progress states. `charts/rop.js` draws the stock-level bar; `charts/flow.js` draws the pipeline and the runway mini bar.
