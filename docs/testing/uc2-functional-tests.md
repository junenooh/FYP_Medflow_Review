# UC2 Functional Test Cases — Replenishment Page

**Feature under test:** UC2 Replenishment page (`#/uc2`): Stock status, product panel, Restocks, History and the notification bell
**Test type:** Functional (black-box) testing through the browser
**Environment:** Chromium (Playwright 1.48, headless), Vite dev server at http://127.0.0.1:5173, live Supabase data as of 14 Oct 2026

> **Last run: 2026-10-19: 25 Pass, 2 Fail (FT-022, FT-023).** Each expected result was checked on the page and, for
> FT-001, 005, 008, 009, 010, 015, 016, 019 and 027, against the database (`uc2_policy_parameters`, `orders`, `orderline`).
> A screenshot was taken for every case.
> Evidence (screenshots, exported CSV, test script): [evidence/uc2-2026-10-19](evidence/uc2-2026-10-19/README.md).

Unit tests check the engine and page logic on their own (see `uc2-unit-tests.md`). These functional tests check what a
planner sees and does on the page. How each acceptance criterion is covered is shown in `uc2-traceability.md`.

## Common pre-conditions

1. `uc2_policy_parameters` holds the policy for every subsidiary (run `python -m engines.uc2.replenishment`), and the
   nightly reorder check has placed restocks (`python -m scripts.live.day`).
2. Start the frontend with `npm run dev`.
3. Open http://localhost:5173/#/uc2, or click **Replenishment** in the sidebar.

Reference data on 2026-10-19 for WH002: 1,000 products (27 out of stock, 86 low stock, 183 near reorder point, 704 in
stock); restocks PO-WH002-20261014 (placed) and PO-WH002-20261013 (on its way). MED0147 *Zyloric Allopurinol
Original 100mg*: 45 on the shelf, reorder point 125, safety stock 71, order-up-to level 232.

## Test cases

| Test Case ID | User Story | Test Scenarios | Pre-conditions | Test Step | Test Data | Expected Result | Test Status | Remarks |
|---|---|---|---|---|---|---|---|---|
| TC-UC2-FT-001 | UC2.4, UC2.5 | Verify that the Replenishment page loads with the first subsidiary | Common pre-conditions | 1. Click "Replenishment" in the sidebar<br>2. Observe the page | — | Title "Replenishment"; subsidiary WH002; "Data as of …"; restock pipeline; tabs Stock status, Restocks, History; table columns Product, Status, Stock level, Runs out in, Restock; one row per product | Pass | 1,000 products; "Data as of 14 Oct 2026 · updated 15 Oct 2026, 08:07" |
| TC-UC2-FT-002 | UC2.4 | Verify that the user can switch subsidiary | FT-001 passed | 1. Open the Subsidiary list<br>2. Select WH004 | Subsidiary = WH004 | The list holds WH002–WH006 (no central warehouse); the URL has warehouse=WH004 and the table shows WH004's products | Pass | 1,000 products at WH004 |
| TC-UC2-FT-003 | UC2.4 | Verify that the status counts match the table | WH002 | 1. Note each status chip's count<br>2. Count the statuses in the table | — | Out of stock, Low stock, Near ROP and In stock counts equal the rows with that status; All = total | Pass | 27 / 86 / 183 / 704, All 1,000 |
| TC-UC2-FT-004 | UC2.4, UC2.5 | Verify the status filter | WH002 | 1. Click each status chip in turn | Each status | Only products with that status are listed | Pass | NIL |
| TC-UC2-FT-005 | UC2.4, US2.2 | Verify that each status follows the rule on inventory position | WH002 | 1. Take 3 products of each status<br>2. Compare "on the shelf + on its way" with the reorder point and safety stock in the database | 12 products | Out of stock: nothing on the shelf; Low stock: position ≤ reorder point; Near ROP: ≤ reorder point + safety stock; In stock: above. The reorder point shown equals the stored one | Pass | NIL |
| TC-UC2-FT-006 | UC2.5 | Verify that the most urgent products come first | WH002 | 1. Read the status column top to bottom | — | Out of stock, then Low stock, Near ROP, In stock | Pass | First row: MED0011 (out of stock) |
| TC-UC2-FT-007 | UC2.4 | Verify the product search | WH002 | 1. Search "MED0147"<br>2. Search "Allopurinol" | — | 1: only MED0147. 2: only Allopurinol products | Pass | 6 Allopurinol products |
| TC-UC2-FT-008 | UC2.4, UC2.5, US2.1 | Verify the product panel's key figures and plain-English reason | WH002 | 1. Open MED0147 | MED0147 | Panel shows on the shelf, reorder point and order-up-to level equal to the database (45, 125, 232), stock lasts / lead time, and a one-line reason | Pass | Reason: "At its reorder point of 125." |
| TC-UC2-FT-009 | UC2.5, US2.1 | Verify that the calculation is hidden by default and correct when opened | MED0147 panel open | 1. Check "How it's calculated" is closed<br>2. Open it | MED0147 | Closed by default; shows inventory position, lead-time demand + safety stock = reorder point, the decision and tonight's order, with the stored values | Pass | Lead-time demand 54 + safety stock 71 = reorder point 125 |
| TC-UC2-FT-010 | US2.2, US2.1 | Verify tonight's restock quantity in whole cartons | WH002, Low stock filter | 1. Open 3 products ordering tonight<br>2. Compare cartons with the carton rule | MED0018, MED0026, MED0070 | Cartons = nearest whole carton to (order-up-to level − position), never fewer than it takes to clear the reorder point | Pass | Gap 70 → 3 × 24 = 72; gap 29 → 1 × 24; gap 322 → 13 × 24 = 312 |
| TC-UC2-FT-011 | US2.2 | Verify that nothing is ordered above the reorder point | WH002, In stock filter | 1. Open an in-stock product with no restock pending<br>2. Open "How it's calculated" | MED0861 | "Next restock" card ("Ordered automatically when stock reaches …"); decision "No order needed"; no order quantity | Pass | Observation: MED0344 shows "In stock" with 1 on the shelf because 168 are on the way; correct by the rule, but may surprise a planner |
| TC-UC2-FT-012 | US2.3 | Verify the progress of a restock on its way | WH002 | 1. Open a product with "On its way" | MED0011 | "Restock progress" with the order number, units, cartons, days of stock, and steps Ordered → On its way → Delivered | Pass | PO-WH002-20261013: 48 units, 2 cartons, about 3 days of stock |
| TC-UC2-FT-013 | UC2.5 | Verify the 30-day stock chart | MED0147 panel open | 1. Wait for the chart | — | 30 days drawn; the readout describes today in plain words | Pass | "Today · 96 delivered in the morning · 45 on the shelf at closing" |
| TC-UC2-FT-014 | US2.3 | Verify that UC1 companions are shown as suggestions only | WH002 | 1. Open a product marked "Used with …"<br>2. Open "Often used with this" | MED0011 | Companions listed with advice (Same delivery / Already on order / Due as well / Worth adding / Not needed); no control adds them to an order | Pass | NIL |
| TC-UC2-FT-015 | US2.3 | Verify the Restocks board | WH002 | 1. Open the Restocks tab | — | Columns Order placed, On its way, Delivered; every open restock in the database is on the board | Pass | 7 restocks shown, incl. PO-WH002-20261014 and -20261013 |
| TC-UC2-FT-016 | US2.3 | Verify a restock's items and why each was ordered | Restocks tab | 1. Click the newest restock | PO-WH002-20261014 | The items are listed with the reason each was ordered; companion lines (ending in "C") are tagged | Pass | 139 lines, no companion lines yet in the data, so the companion tag could not be seen on the page (UT-106 covers it) |
| TC-UC2-FT-017 | UC2.4 | Verify the Restocks list view and its filter | Restocks tab | 1. Click "List"<br>2. Click the "Delivered" chip | — | Only delivered restocks are listed | Pass | 10 restocks |
| TC-UC2-FT-018 | UC2.4 | Verify that the History tab shows live data | WH002 | 1. Open the History tab | — | A "LIVE DATA" banner with the 90-day range; the period tiles and calendar load | Pass | Loads in about 10–15 s; "Daily stock for WH002, 17 Jul 2026 to 14 Oct 2026" |
| TC-UC2-FT-019 | UC2.4, US2.1 | Verify the stock export | WH002 | 1. Click "Export CSV" | — | `MedFlow-UC2-WH002-stock-<date>.csv` with one row per product and columns incl. Status, Reorder point, Safety stock, Order-up-to level | Pass | 1,000 rows |
| TC-UC2-FT-020 | UC2.4 | Verify the notification bell and that an alert links to its products | Any page | 1. Wait for the bell to finish checking<br>2. Open it<br>3. Click the first alert | — | Headline, alerts with warehouse and time; the alert opens the Replenishment page focused on its products | Pass | "60 products need action"; first alert opened WH002 with its 13 products |
| TC-UC2-FT-021 | UC2.5 | Verify the "Running low" shortcut | WH002 | 1. Click "Running low" in the pipeline | — | Only out-of-stock and low-stock products are listed | Pass | 113 products |
| TC-UC2-FT-022 | UC2.5 | Verify that the main view avoids technical terms (ROP, OUTL, EOQ) | WH002 | 1. Read the table headers, status chips, legend, pipeline and first 30 rows | — | No ROP, OUTL, OUL or EOQ as labels | Fail | "Near ROP" appears in the status chip, status column and legend |
| TC-UC2-FT-023 | UC2.5 | Verify the status names | WH002 | 1. Read the status chips | — | Out of Stock, Reorder Now, Near Reorder Level, Available | Fail | The page shows Out of stock, Low stock, Near ROP, In stock |
| TC-UC2-FT-024 | — | Verify that an unknown subsidiary in the URL does not break the page | Common pre-conditions | 1. Open #/uc2?warehouse=WH999 | WH999 | The page loads without an error and says what it is showing | Pass | Shows the 9-product sample with a "SAMPLE DATA" banner, while the list says WH002; a live WH002 fallback would be clearer. Robustness check |
| TC-UC2-FT-025 | — | Verify the fallback when the database cannot be reached | Common pre-conditions | 1. Block the database (DevTools offline or blocked requests)<br>2. Open the page | — | A "SAMPLE DATA" banner explains that live data isn't available | Pass | Robustness check |
| TC-UC2-FT-026 | UC2.4 | Verify that a link to a product opens its panel | Common pre-conditions | 1. Open #/uc2?warehouse=WH002&tab=skus&sku=MED0011 | MED0011 | MED0011's panel opens and its row is marked | Pass | Used by notification links |
| TC-UC2-FT-027 | UC2.5, US2.1 | Verify that the page shows the stored policy and does not recalculate it | WH002 | 1. Read the reorder point of every 50th product<br>2. Compare with `uc2_policy_parameters` | 20 products | Every reorder point on the page equals the stored value | Pass | NIL |
