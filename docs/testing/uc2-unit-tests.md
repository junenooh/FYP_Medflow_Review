# UC2 Unit Test Cases — Replenishment Policy

**Last run:** 2026-10-19. Engine 21 passed (15 test cases), page logic 9 passed, policy data verification 8 passed, 0 failed.
**Evidence:** [evidence/uc2-2026-10-19](evidence/uc2-2026-10-19/README.md) (test output and mutation results)

UC2 splits its logic across three places, so it is tested at three levels:

| Level | What it covers | Test file | How to run |
|---|---|---|---|
| Engine unit tests (UT-001–015) | The run in `engines/uc2/replenishment.py` (settings, consumption, policy, in order), service levels (`service_levels.py`) and the Python copy of the policy rules used by the backtest (`backtest.py`) | `tests/engines/test_uc2_replenishment.py` | `python -m pytest tests/engines -v` |
| Page-logic unit tests (UT-101–109) | Inventory position, status, restock quantity and cartons (`live-data.js` `assemble`), UC1 companion advice (`companions.js`) and stock alerts (`notifications/rules.js`) | `tests/frontend/test_uc2_replenishment.mjs` | `node --test tests/frontend/test_uc2_replenishment.mjs` |
| Policy data verification (DV-001–008) | The policy maths, which runs inside Postgres (`sql/uc2/uc2_setup.sql`, `uc2_calc`), checked against every row it stored | `tests/integration/test_uc2_policy_db.py` | `python -m pytest tests/integration -v` (needs `.env.local`; skipped without it) |

**Tool:** pytest 9.1 · Python 3.14 · NumPy · Node.js 24 (`node:test`) · Vite 6 (loads the page modules)

The engine and page-logic tests use no database: the Supabase client is replaced by a fake that records every
call, and the page tests build the raw rows by hand. The data verification reads the live Supabase project
(read-only, anon key) and writes nothing.

## What UC2 does (the behaviour under test)

| Step | Rule | Where |
|---|---|---|
| Classify each product | ADI = days observed ÷ days with demand; CV² = (std ÷ mean of non-zero days)². ADI < 1.32 and CV² < 0.49 → smooth; ADI < 1.32 → erratic; CV² < 0.49 → intermittent; else lumpy. One demand day → insufficient; none → dormant | `uc2_calc` (SQL), `backtest.classify` |
| Forecast daily demand μ | Smooth: exponential smoothing (SES). Erratic, intermittent, lumpy: Syntetos–Boylan (SBA), μ = (1 − α/2) × z ÷ p. Dormant: 0 | `uc2_calc`, `backtest.f_ses` / `f_sba` |
| Safety stock | SS = z × √(LT × σ² + μ² × σ_LT²), with σ floored at √μ | `uc2_calc`, `backtest.reorder_points` |
| Reorder point | ROP = ⌈μ × LT + SS⌉, at least 1 when μ > 0, 0 when μ = 0 | same |
| Order-up-to level | OUL = ⌈μ × (LT + T) + SS⌉, at least ROP + 1 | `uc2_calc` |
| Service level z | Per product by criticality (Vital 2.576, Essential, Desirable 1.476 …), else the default 1.65 | `service_levels.py` → `uc2_settings` |
| Inventory position | On hand + units on open restocks | `live-data.js` |
| Status (page) | Out of Stock: on hand ≤ 0 · Low Stock: position ≤ ROP · Near ROP: position ≤ ROP + SS · Available: above | `live-data.js` |
| Restock quantity | OUL − position when Out of Stock or Low Stock and position ≤ ROP, else 0 | `live-data.js` |
| Cartons | Nearest whole carton to the quantity, never fewer than it takes to lift the position above ROP, at least 1 (same rule as the nightly reorder check, `scripts/live/day.py`) | `live-data.js`, `cartonise` |

Settings on 2026-10-19 (`uc2_settings`, global row): z 1.65, lead time 2 days, coverage 4 days, σ_LT 0.45 days,
α 0.033, classification window 365 days, Near-ROP band 20% (SQL status only).

## Engine unit tests (TC-UC2-UT-001 – 015)

| Test Case ID | User Story | Test Scenario | Pre-conditions | Test Steps | Test Data | Expected Result | Test Status | Remarks |
|---|---|---|---|---|---|---|---|---|
| TC-UC2-UT-001 | US2.1 | Verify that the "last real day" pin resolves correctly | None | 1. Call `_resolve_pin(pin, "2026-10-14")` for each pin | None, "", 2026-10-05, 2026-10-20, 14/10/2026 | 2026-10-14; 2026-10-14; 2026-10-05; error "after the last day"; error "YYYY-MM-DD" | Pass | A pin after the ledger would invent zero-demand days |
| TC-UC2-UT-002 | US2.1 | Verify that configured settings are passed to the database | None | 1. Call `_seed_args(config, force=True)` 2. Call it with sparse settings | z 1.65, LT 2, T 4, σ_LT 0.45, α 0.033, window 365, Near-ROP 0.2, overstock 180 | Every setting maps to its `p_` argument plus `p_force`; unset values are left out | Pass | NIL |
| TC-UC2-UT-003 | US2.1 | Verify that the policy covers every subsidiary and never the central warehouse | Fake client | 1. Call `_subsidiaries(client, "WH001")` 2. Repeat with no warehouse roles | WH001 central, WH002, WH003 | ["WH002", "WH003"], sorted; without roles, every warehouse except WH001 | Pass | NIL |
| TC-UC2-UT-004 | US2.1 | Verify that the database functions must match the repo's schema version | Fake client | 1. Call `_check_schema` with a matching, an older and a missing version | uc2-3.3, uc2-0.1, error | None; "this repo expects …"; "not installed" | Pass | NIL |
| TC-UC2-UT-005 | US2.1 | Verify the order of a daily run | Fake client; consumption has rows | 1. Call `run()` 2. Read the calls made | 2 subsidiaries, 1,000 products each | Schema check → settings → ledger end → append consumption → policy for WH002 and WH003 as of 2026-10-14 → summary; status success, 10 rows in, 2,000 policies out | Pass | NIL |
| TC-UC2-UT-006 | US2.1 | Verify that a first run builds consumption warehouse by warehouse in slices | Fake client; consumption empty | 1. Call `run()` | 3 slices per warehouse | 6 build calls (WH002 slices 0–2, WH003 slices 0–2), each up to 2026-10-14; no append | Pass | Slicing keeps each call under Supabase's 60-second limit |
| TC-UC2-UT-007 | US2.1 | Verify that the pin sets the policy date | Fake client | 1. Call `run()` with the pin 2026-10-05 | Ledger ends 2026-10-14 | Consumption appended up to 2026-10-05 and the policy computed as of 2026-10-05 | Pass | NIL |
| TC-UC2-UT-008 | US2.1 | Verify that a rebuild empties consumption only after every check passes | Fake client | 1. `run(mode="rebuild")` 2. Repeat with a pin after the ledger | Good pin; bad pin 2026-12-31 | 1: reset happens after the ledger check, then a full build. 2: run fails and consumption is never emptied | Pass | NIL |
| TC-UC2-UT-009 | US2.1 | Verify that a stale schema stops the run before any write | Fake client, schema uc2-1.0 | 1. Call `run()` | — | Status failed, error names uc2-3.3; only the version check was called | Pass | NIL |
| TC-UC2-UT-010 | — | Verify that a run fails cleanly with no subsidiaries or an empty ledger | Fake client | 1. Run with only WH001 2. Run with an empty ledger | — | "no subsidiary warehouses"; "ledger is empty"; no policy written | Pass | Robustness check |
| TC-UC2-UT-011 | US2.1 | Verify the service-level class: product form, then category, then default | None | 1. Call `service_levels.classify` for each product | Inhaler (Analgesics); tablet (Anticoagulants); Analgesics; Vitamins | Vital; Vital; Desirable; Essential | Pass | The class sets the product's z-score |
| TC-UC2-UT-012 | US2.1, US2.2 | Verify the demand class from ADI 1.32 and CV² 0.49 | None | 1. Call `backtest.classify` on each 365-day series | No demand; 1 day; every day same; every day 1/30 alternating; every 3rd day; 5 days in 7; every 3rd day 1/30 | dormant; insufficient; smooth; erratic; intermittent; intermittent (ADI 1.4); lumpy | Pass | Same rules as `uc2_calc`; DV-005 checks the stored classes |
| TC-UC2-UT-013 | US2.1 | Verify the reorder point against a hand calculation | None | 1. Call `reorder_points` | MED0147 at WH002: μ 26.85, σ 24.08, z 1.96, LT 2, σ_LT 0.45 | SS = 1.96 × √(2 × 24.08² + 26.85² × 0.45²) = 70.81; ROP = ⌈53.70 + 70.81⌉ = 125 | Pass | Matches the stored value |
| TC-UC2-UT-014 | US2.1, US2.2 | Verify the σ floor and zero demand | None | 1. Call `reorder_points` | μ 4, σ 0; μ 0; μ 0.1 | 13 (σ raised to √4 = 2); 0; 1 | Pass | NIL |
| TC-UC2-UT-015 | US2.1 | Verify that the SBA forecast removes Croston's bias | None | 1. Call `f_sba` on 10 units every 4th day | α 0.033 | μ = (1 − 0.033/2) × 10 ÷ 4 = 2.459 | Pass | NIL |

## Page-logic unit tests (TC-UC2-UT-101 – 109)

Every product in these tests has reorder point 100, safety stock 30, order-up-to level 200, use of 20 a day and a carton of 24.

| Test Case ID | User Story | Test Scenario | Pre-conditions | Test Steps | Test Data | Expected Result | Test Status | Remarks |
|---|---|---|---|---|---|---|---|---|
| TC-UC2-UT-101 | UC2.4 | Verify the four status bands, including their exact edges | Raw rows built in memory | 1. Call `assemble` 2. Read each status | On hand 0, 100, 80, 120, 130, 131 | Out of Stock; Low Stock (= ROP); Low Stock; Near ROP; Near ROP (= ROP + SS); Available | Pass | NIL |
| TC-UC2-UT-102 | US2.2, UC2.4 | Verify that a product with no demand is never flagged | — | 1. `assemble` a dormant product with nothing on hand | μ 0, ROP 0 | Available; restock 0 | Pass | NIL |
| TC-UC2-UT-103 | US2.2 | Verify that inventory position counts units already on the way | One open restock | 1. `assemble` 2. Read the product | 50 on hand + 60 on the way | On the way 60; position 110 > ROP: Near ROP, no new restock; its open order is attached | Pass | NIL |
| TC-UC2-UT-104 | US2.2 | Verify restock quantity = order-up-to level − inventory position, only when due | — | 1. `assemble` 2. Read the quantities | On hand 80, 0, 120, 180; and 30 on hand + 20 on the way | 120; 200; 0; 0; and 150 (200 − 50, not 200 − 30) | Pass | Extended after mutation testing (M14) |
| TC-UC2-UT-105 | US2.1 | Verify whole cartons: nearest to the quantity, never fewer than it takes to clear the reorder point | — | 1. `assemble` 2. Read cartons and units | Gap 120; gap 200; order-up-to 105 with 0 on hand | 5 × 24 = 120; 8 × 24 = 192 (8.33 rounded); 5 × 24 = 120 (4.4 would round to 4, but 101 units are needed) | Pass | Same rule as the nightly reorder check |
| TC-UC2-UT-106 | US2.3 | Verify restock status, timing and companion lines | 3 restocks | 1. `assemble` 2. Read the orders | Placed 14 Oct (open), 12 Oct (open), 10 Oct (delivered 12 Oct); a line ending in "C" | Processing; In Transit; Fulfilled; placed at 23:30; delivered 12 Oct; the "C" line is a companion; both open restocks count as on the way, the delivered one does not | Pass | NIL |
| TC-UC2-UT-107 | US2.3 | Verify that UC1 companions are advice only, based on the companion's own position | — | 1. Call `companionAdvice` for each companion | Companion Near ROP, Low Stock, Available, on order, on the same open restock | Worth adding; Due as well; Not needed; Already on order; Same delivery | Pass | Nothing here changes an order |
| TC-UC2-UT-108 | UC2.4 | Verify that out-of-stock alerts are urgent and say whether a restock is coming | 1 open restock | 1. `buildAlerts` 2. Read the out-of-stock alerts | Out of stock with and without a restock; one in stock | Urgent; "Delivery on the way"; "Ordering tonight"; no urgent alert for the stocked product; each alert links to WH002 | Pass | NIL |
| TC-UC2-UT-109 | UC2.5 | Verify that the headline leads with what needs action | — | 1. `headline(buildAlerts(…))` | 2 products out of stock, both ordering tonight | Lead "Restocks are on the way", detail "2 out of stock · 1 subsidiary"; no alerts → "No stock problems" | Pass | NIL |

## Policy data verification (TC-UC2-DV-001 – 008)

Run against the live `uc2_policy_parameters` on 2026-10-19: 5,000 rows (5 subsidiaries × 1,000 products), as of 14 Oct 2026.

| Test Case ID | User Story | Test Scenario | Expected Result | Test Status | Remarks |
|---|---|---|---|---|---|
| TC-UC2-DV-001 | US2.1 | One policy row per subsidiary and product, with its run record | No WH001 rows; each subsidiary has the same products; no duplicates; one as-of day; every row has computedat, method and class | Pass | 5,000 rows |
| TC-UC2-DV-002 | US2.1 | Safety stock matches the formula | SS = z × √(LT × σ² + μ² × σ_LT²), σ ≥ √μ, for every row with demand | Pass | 5,000 of 5,000 |
| TC-UC2-DV-003 | US2.1, US2.2 | Reorder point matches the formula | ROP = ⌈μ × LT + SS⌉, ≥ 1 when μ > 0, 0 when μ = 0 | Pass | 5,000 of 5,000 |
| TC-UC2-DV-004 | US2.1 | Order-up-to level matches the formula | OUL = ⌈μ × (LT + T) + SS⌉, ≥ ROP + 1 | Pass | 5,000 of 5,000 |
| TC-UC2-DV-005 | US2.1 | Demand class and forecast method follow ADI and CV² | smooth / erratic / intermittent / lumpy from ADI 1.32 and CV² 0.49; SES for smooth, SBA otherwise | Pass | 3,226 smooth, 1,683 intermittent, 90 lumpy, 1 erratic |
| TC-UC2-DV-006 | UC2.4 | Stored stock status follows the reorder point | Low Stock: stock ≤ ROP; Near ROP: ≤ ROP × 1.2; Available above; Dormant when μ = 0 | Pass | This is the database's own band (20%), which differs from the page's (ROP + safety stock): see the traceability |
| TC-UC2-DV-007 | US2.1 | z-score comes from the product's service level, else the default | Every row's z equals its product override in `uc2_settings`, or 1.65 | Pass | 1,000 product overrides |
| TC-UC2-DV-008 | US2.1, US2.3 | Restocks placed by the nightly check are whole cartons | Every order line since 6 Oct has a positive quantity that is a multiple of the product's carton (`storage.shippingcasepack`) | Pass | NIL |

## Verifying test accuracy (mutation testing)

Each bug below was written into the source on its own, the matching suite was run, and the original file was
restored byte for byte (run on 2026-10-19; `git status` confirmed the sources unchanged).

| ID | Injected bug | File | Result | Caught by |
|---|---|---|---|---|
| M1 | Pin after the last ledger day accepted | replenishment.py | Caught | UT-001, UT-008 |
| M2 | Flag thresholds not passed to the database | replenishment.py | Caught | UT-002 |
| M3 | Central warehouse included in the policy run | replenishment.py | Caught | UT-003, UT-005, UT-006, UT-010 |
| M4 | Schema version not checked | replenishment.py | Caught | UT-004, UT-009 |
| M5 | Auto mode picks the wrong consumption step | replenishment.py | Caught | UT-005, UT-006, UT-007 |
| M6 | Policy computed as of the ledger end, ignoring the pin | replenishment.py | Caught | UT-007 |
| M7 | Demand-class ADI cut-off 1.32 → 1.5 | backtest.py | Caught (after UT-012 gained the ADI 1.4 case) | UT-012 |
| M8 | √μ floor on σ removed | backtest.py | Caught | UT-014 |
| M9 | SBA bias correction removed | backtest.py | Caught | UT-015 |
| M10 | Product form ignored for the service level | service_levels.py | Caught | UT-011 |
| M11 | Low Stock uses < instead of ≤ | live-data.js | Caught | UT-101 |
| M12 | Inventory position ignores units on the way | live-data.js | Caught | UT-103, UT-104 |
| M13 | Near ROP band without the safety stock | live-data.js | Caught | UT-101, UT-103 |
| M14 | Restock quantity uses stock on hand, not position | live-data.js | Caught (after UT-104 gained the on-the-way case) | UT-104 |
| M15 | Cartons always rounded up | live-data.js | Caught | UT-105 |
| M16 | Clear-the-reorder-point minimum removed | live-data.js | Caught | UT-105 |
| M17 | Companion lines not recognised | live-data.js | Caught | UT-106 |
| M18 | Delivered restocks counted as on the way | live-data.js | Caught | UT-106 |
| M19 | Near ROP companions not suggested | companions.js | Caught | UT-107 |
| M20 | Out-of-stock alert ignores the delivery on the way | rules.js | Caught | UT-108 |

**Score: 20 of 20 bugs detected.** M7 and M14 survived the first run, which showed two gaps: no test sat between
ADI 1.32 and 1.5, and no test had a restock due while units were already on the way. A case was added for each.

## What is not unit tested, and why

| Area | Reason | Covered by |
|---|---|---|
| The SQL functions themselves (`uc2_calc`, consumption build) | They run inside Postgres and need a database | Data verification DV-001–008 on every stored row |
| The nightly reorder check and companion orders (`scripts/live/day.py`) | A simulation script that writes to the database; no unit tests yet | DV-008 (whole cartons), functional tests FT-012, FT-015, FT-016 |
| Page rendering (table, panel, charts, filters, export) | Browser behaviour | Functional tests FT-001–027 |
