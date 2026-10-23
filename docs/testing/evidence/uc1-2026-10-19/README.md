# UC1 test evidence — 2026-10-19

Evidence for the UC1 (Product Relationships) unit and functional tests run on **19 October 2026**.
Test cases and full results: [uc1-functional-tests.md](../../uc1-functional-tests.md), [uc1-unit-tests.md](../../uc1-unit-tests.md), [uc1-traceability.md](../../uc1-traceability.md).

| Suite | Result | Evidence |
|---|---|---|
| Unit tests (`tests/engines/test_uc1_arm.py`, engine `arm_jeremiahVer.py`) | 32 passed, 0 failed (26 test cases) | [unit/pytest-output.txt](unit/pytest-output.txt) |
| Mutation testing | 13 of 13 non-equivalent bugs detected | [unit/mutation-results.md](unit/mutation-results.md) |
| Functional tests (page `#/uc1`) | 29 Pass, 1 Fail (FT-013), 1 Blocked (FT-027) | Screenshots below |

## How the functional tests were run

Headless Chromium (Playwright 1.48) drove the local dev server (`npm run dev`, http://127.0.0.1:5173/#/uc1) against the live Supabase data at 1440 × 1000. Each expected result was checked on the page, and FT-015, FT-016, FT-017 and FT-029 were also checked against `productrelationship`. The script is [functional/run-functional-tests.mjs](functional/run-functional-tests.mjs). Each screenshot shows the page at the end of its test.

## Functional test screenshots

| Test | User story | Scenario | Status | Screenshot |
|---|---|---|---|---|
| FT-001 | US1.6, US1.9, US1.13 | Verify that the Product Relationships page loads with the network view (all subsidiaries together) | Pass | [FT-001.png](functional/FT-001.png) |
| FT-002 | US1.8 | Verify that the user can view rules for a single subsidiary warehouse | Pass | [FT-002.png](functional/FT-002.png) |
| FT-003 | US1.11 | Verify that subsidiaries cannot be selected while the network view (WH001) is selected | Pass | [FT-003.png](functional/FT-003.png) |
| FT-004 | US1.11 | Verify that ticking a subsidiary disables the network view | Pass | [FT-004.png](functional/FT-004.png) |
| FT-005 | US1.11 | Verify that "Select all Subsidiary Warehouse" selects every subsidiary | Pass | [FT-005.png](functional/FT-005.png) |
| FT-006 | US1.11 | Verify that the user can view several chosen subsidiaries at once | Pass | [FT-006.png](functional/FT-006.png) |
| FT-007 | US1.11 | Verify that Apply is disabled when no warehouse is selected | Pass | [FT-007.png](functional/FT-007.png) |
| FT-008 | US1.11 | Verify that closing the picker without Apply discards the changes | Pass | [FT-008.png](functional/FT-008.png) |
| FT-009 | US1.11 | Verify that the warehouse info tooltip explains the selection rule | Pass | [FT-009.png](functional/FT-009.png) |
| FT-010 | US1.10, US1.13 | Verify that the Recommendation filter applies to both the table and the graph | Pass | [FT-010.png](functional/FT-010.png) |
| FT-011 | US1.10, US1.13 | Verify that the Bundle size filter applies to both the table and the graph | Pass | [FT-011.png](functional/FT-011.png) |
| FT-012 | US1.6 | Verify that searching by product ID filters both the table and the graph | Pass | [FT-012.png](functional/FT-012.png) |
| FT-013 | US1.6 | Verify that the page handles a search with no results | Fail | [FT-013.png](functional/FT-013.png) |
| FT-014 | US1.10 | Verify that the table paginates 10 rows per page | Pass | [FT-014.png](functional/FT-014.png) |
| FT-015 | US1.6, US1.9 | Verify that the KPI values match the database | Pass | [FT-015.png](functional/FT-015.png) |
| FT-016 | US1.6, US1.13 | Verify that the page shows stored values and does not recalculate them | Pass | [FT-016.png](functional/FT-016.png) |
| FT-017 | US1.7, US1.13 | Verify that "Export filtered rows" downloads exactly the filtered rules with matching values | Pass | [FT-017.png](functional/FT-017.png) |
| FT-018 | US1.6 | Verify that selecting a table row highlights its products in the graph | Pass | [FT-018.png](functional/FT-018.png) |
| FT-019 | US1.6, US1.13 | Verify that the graph sliders filter the links | Pass | [FT-019.png](functional/FT-019.png) |
| FT-020 | US1.6 | Verify the graph view controls | Pass | [FT-020.png](functional/FT-020.png) |
| FT-021 | US1.6, US1.13 | Verify that hovering over a link shows its metrics | Pass | [FT-021.png](functional/FT-021.png) |
| FT-022 | — | Verify that an invalid warehouse in the URL falls back to a valid warehouse | Pass | [FT-022.png](functional/FT-022.png) |
| FT-023 | — | Verify that an error message is shown when the database cannot be reached | Pass | [FT-023.png](functional/FT-023.png) |
| FT-024 | US1.12 | Verify that hovering over a product ID shows its product name | Pass | [FT-024.png](functional/FT-024.png) |
| FT-025 | US1.12, US1.13 | Verify that the column info icons explain each column in plain language | Pass | [FT-025.png](functional/FT-025.png) |
| FT-026 | US1.11 | Verify that the graph shows a product pair only once when several warehouses are selected | Pass | [FT-026.png](functional/FT-026.png) |
| FT-027 | US1.8, US1.9 | Verify that a message is shown when a warehouse has no relationships | Blocked | [FT-027.png](functional/FT-027.png) |
| FT-028 | US1.13 | Verify that the main table, KPIs, filters and graph do not use technical terms as primary labels | Pass | [FT-028.png](functional/FT-028.png) |
| FT-029 | US1.13 | Verify that each combination shows a plain recommendation that matches its stored strength | Pass | [FT-029.png](functional/FT-029.png) |
| FT-030 | US1.13 | Verify that the graph explains how to read it | Pass | [FT-030.png](functional/FT-030.png) |
| FT-031 | US1.6 | Verify that the search also matches product names | Pass | [FT-031.png](functional/FT-031.png) |

FT-017 also saved the exported file: [functional/FT-017-export-uc1-rules-4a13d620.csv](functional/FT-017-export-uc1-rules-4a13d620.csv).

## Open findings

- **FT-013 (Fail):** a search with no matches shows "No engine output yet: Run the Python engines…" instead of a "no matches" message.
- **FT-027 (Blocked):** every warehouse (WH001–WH006) has 98 rules, so there is no warehouse with no relationships to test.
- **FT-023 (Pass, note):** with the database unreachable, the error appears after about 10–15 s, and its text says the tables are "reachable in principle".
