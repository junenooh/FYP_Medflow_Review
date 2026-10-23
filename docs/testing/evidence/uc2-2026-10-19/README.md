# UC2 test evidence — 2026-10-19

Evidence for the UC2 (Replenishment) unit tests, policy data verification and functional tests run on **19 October 2026**.
Test cases and full results: [uc2-unit-tests.md](../../uc2-unit-tests.md), [uc2-functional-tests.md](../../uc2-functional-tests.md), [uc2-traceability.md](../../uc2-traceability.md).

| Suite | Result | Evidence |
|---|---|---|
| Engine unit tests (`tests/engines/test_uc2_replenishment.py`) | 21 passed, 0 failed (15 test cases) | [unit/pytest-engine-output.txt](unit/pytest-engine-output.txt) |
| Page-logic unit tests (`tests/frontend/test_uc2_replenishment.mjs`) | 9 passed, 0 failed | [unit/node-page-logic-output.txt](unit/node-page-logic-output.txt) |
| Policy data verification (`tests/integration/test_uc2_policy_db.py`) | 8 passed, 0 failed (5,000 policy rows) | [unit/pytest-policy-data-verification-output.txt](unit/pytest-policy-data-verification-output.txt) |
| Mutation testing | 20 of 20 bugs detected | [unit/mutation-results.md](unit/mutation-results.md) |
| Functional tests (page `#/uc2`) | 25 Pass, 2 Fail (FT-022, FT-023) | Screenshots below |

## How the functional tests were run

Headless Chromium (Playwright 1.48) drove the local dev server (http://127.0.0.1:5173/#/uc2) against the live Supabase data (policy as of 14 Oct 2026) at 1440 × 1000. Expected results were checked on the page and, where a number is involved, against `uc2_policy_parameters`, `orders` and `orderline`. The script is [functional/run-functional-tests.mjs](functional/run-functional-tests.mjs). Each screenshot shows the page at the end of its test.

## Functional test screenshots

| Test | User story | Scenario | Status | Screenshot |
|---|---|---|---|---|
| FT-001 | UC2.4, UC2.5 | Verify that the Replenishment page loads with the first subsidiary | Pass | [FT-001.png](functional/FT-001.png) |
| FT-002 | UC2.4 | Verify that the user can switch subsidiary | Pass | [FT-002.png](functional/FT-002.png) |
| FT-003 | UC2.4 | Verify that the status counts match the table | Pass | [FT-003.png](functional/FT-003.png) |
| FT-004 | UC2.4, UC2.5 | Verify the status filter | Pass | [FT-004.png](functional/FT-004.png) |
| FT-005 | UC2.4, US2.2 | Verify that each status follows the rule on inventory position | Pass | [FT-005.png](functional/FT-005.png) |
| FT-006 | UC2.5 | Verify that the most urgent products come first | Pass | [FT-006.png](functional/FT-006.png) |
| FT-007 | UC2.4 | Verify the product search | Pass | [FT-007.png](functional/FT-007.png) |
| FT-008 | UC2.4, UC2.5, US2.1 | Verify the product panel's key figures and plain-English reason | Pass | [FT-008.png](functional/FT-008.png) |
| FT-009 | UC2.5, US2.1 | Verify that the calculation is hidden by default and correct when opened | Pass | [FT-009.png](functional/FT-009.png) |
| FT-010 | US2.2, US2.1 | Verify tonight's restock quantity in whole cartons | Pass | [FT-010.png](functional/FT-010.png) |
| FT-011 | US2.2 | Verify that nothing is ordered above the reorder point | Pass | [FT-011.png](functional/FT-011.png) |
| FT-012 | US2.3 | Verify the progress of a restock on its way | Pass | [FT-012.png](functional/FT-012.png) |
| FT-013 | UC2.5 | Verify the 30-day stock chart | Pass | [FT-013.png](functional/FT-013.png) |
| FT-014 | US2.3 | Verify that UC1 companions are shown as suggestions only | Pass | [FT-014.png](functional/FT-014.png) |
| FT-015 | US2.3 | Verify the Restocks board | Pass | [FT-015.png](functional/FT-015.png) |
| FT-016 | US2.3 | Verify a restock's items and why each was ordered | Pass | [FT-016.png](functional/FT-016.png) |
| FT-017 | UC2.4 | Verify the Restocks list view and its filter | Pass | [FT-017.png](functional/FT-017.png) |
| FT-018 | UC2.4 | Verify that the History tab shows live data | Pass | [FT-018.png](functional/FT-018.png) |
| FT-019 | UC2.4, US2.1 | Verify the stock export | Pass | [FT-019.png](functional/FT-019.png) |
| FT-020 | UC2.4 | Verify the notification bell and that an alert links to its products | Pass | [FT-020.png](functional/FT-020.png) |
| FT-021 | UC2.5 | Verify the "Running low" shortcut | Pass | [FT-021.png](functional/FT-021.png) |
| FT-022 | UC2.5 | Verify that the main view avoids technical terms (ROP, OUTL, EOQ) | Fail | [FT-022.png](functional/FT-022.png) |
| FT-023 | UC2.5 | Verify the status names | Fail | [FT-023.png](functional/FT-023.png) |
| FT-024 | — | Verify that an unknown subsidiary in the URL does not break the page | Pass | [FT-024.png](functional/FT-024.png) |
| FT-025 | — | Verify the fallback when the database cannot be reached | Pass | [FT-025.png](functional/FT-025.png) |
| FT-026 | UC2.4 | Verify that a link to a product opens its panel | Pass | [FT-026.png](functional/FT-026.png) |
| FT-027 | UC2.5, US2.1 | Verify that the page shows the stored policy and does not recalculate it | Pass | [FT-027.png](functional/FT-027.png) |

FT-019 also saved the exported file: [functional/FT-019-export-MedFlow-UC2-WH002-stock-2026-10-14.csv](functional/FT-019-export-MedFlow-UC2-WH002-stock-2026-10-14.csv).

## Open findings

- **FT-022 (Fail):** "Near ROP" is still shown in the status chip, status column and legend (UC2.5 AC2).
- **FT-023 (Fail):** statuses read Out of stock / Low stock / Near ROP / In stock; UC2.5 AC4 asks for Out of Stock / Reorder Now / Near Reorder Level / Available.
- **FT-011 (observation):** a product with 1 on the shelf and 168 on the way shows "In stock", which is correct by the rule but may surprise a planner.
- **FT-024 (observation):** an unknown subsidiary in the URL shows the sample data while the list says WH002.
- **FT-016 (observation):** no companion order lines exist in the data yet, so the companion tag on a restock could only be checked by UT-106.
