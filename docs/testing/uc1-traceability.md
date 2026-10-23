# UC1 Traceability — User Stories → Test Cases

Links every UC1 user story's acceptance criteria (AC) to the unit tests (`TC-UC1-UT-xxx`, see `uc1-unit-tests.md`)
and the functional tests (`TC-UC1-FT-xxx`, see `uc1-functional-tests.md`).

**Last updated:** 2026-10-19. Story IDs and acceptance criteria are taken from the *User Stories* tab of the
Product Backlog & Sprint Review sheet. The engine under test is `engines/uc1/arm_jeremiahVer.py`.

**Test levels:** engine stories (US1.1, US1.2, US1.5, US1.8, US1.9) are covered mainly by unit tests; user-interface
stories (US1.6, US1.7, US1.10–US1.13) are covered by functional tests only, because there are no frontend unit tests yet.
The reasons are explained in `uc1-unit-tests.md` → "User stories without unit tests".

**Coverage status key**

- **Covered** — a test checks this AC directly.
- **Partial** — part of the AC is tested; the rest is noted.
- **Not covered** — no test yet.
- **Not implemented** — no code for this AC was found in the repository, so it cannot pass a test yet.
- **Mismatch** — the AC and the code disagree; the team needs to decide which one is correct.

## What changed since the 2026-10-03 version

- **New engine.** UC1 now mines **hospital requests** (`stocktransfer`) from the last 90 days instead of fulfilled
  CW → SW orders, adds two gates (at least 20 requests per rule, at most 4 products) and grades strength on confidence
  and support only. All unit tests were rewritten for it (`uc1-unit-tests.md`).
- **US1.2 AC3 is no longer a Mismatch.** The code's support gate is now 0.02, as the story says.
- **US1.8 / US1.9 AC6 are now Covered.** `.github/workflows/run-script-UC1.yml` reruns the engine monthly.
- **New story US1.13** (business-friendly language) and its acceptance criteria were added.
- **New mismatches** on US1.1 (hospital requests, not orders) and US1.2 AC4 (new bands).

## User stories

| ID | User story (short) | Sprint | Owner |
|---|---|---|---|
| US1.1 | Group SKU lines into one basket per request so the system can find SKUs ordered together | Sprint 1 | Nicole |
| US1.2 | FP-Growth generates explainable association rules | Sprint 1 | Nicole |
| US1.4 | Sample data supports ARM and links correctly (Data Quality) | Sprint 2 | Regan |
| US1.5 | Save each UC1 run and its results | Sprint 1 | Nicole / Nut |
| US1.6 | Explore relationships in a table and a network graph | Sprint 1 | Nut |
| US1.7 | Export the relationship results | Sprint 1 | Nut |
| US1.8 | Analyse relationships for each individual subsidiary | Sprint 2 | Nicole |
| US1.9 | View overall relationships aggregated across subsidiaries | Sprint 2 | Nut |
| US1.10 | Filter rules by strength and itemset size | Sprint 2 | Nut |
| US1.11 | View relationships across multiple warehouses at once | Sprint 2 | Nut |
| US1.12 | View full product names and metric meanings | Sprint 2 | Nut |
| US1.13 | Business-friendly language and suggested actions for non-technical users | Sprint 4 | Nut |

## Acceptance criteria → test cases

| Story | AC | Acceptance criterion (short) | Test cases | Status | Notes |
|---|---|---|---|---|---|
| US1.1 | 1 | Each order ID produces one basket with unique product IDs | UT-001, UT-002 | Covered | The basket is now one **hospital request**, not one order. Duplicate product lines are counted once |
| US1.1 | 2 | Only in-scope central-to-subsidiary order history is used; baskets with fewer than 2 SKUs are excluded | UT-002, UT-012, UT-013, UT-022, UT-026 | Mismatch | Fewer-than-2 exclusion is covered. "In scope" is now hospital requests from the last 90 days, not CW → SW order history. The team should reword the AC (the engine explains why: mining UC2's own orders would rediscover UC2's behaviour) |
| US1.1 | 3 | Missing or invalid order/product references are skipped and logged without stopping the run | — | Not implemented | The extract joins request lines to requests and drops lines without a request silently; product IDs are not checked and nothing is logged |
| US1.1 | 4 | The run reports source-row, valid-basket and excluded-record counts | UT-013, UT-014 | Partial | `run()` returns the request count (`input_rows`) and the rule count (`output_rows`), and prints requests and rules per scope. The basket count is calculated but not returned; the excluded count is not calculated |
| US1.2 | 1 | FP-Growth uses a minimum itemset support of 0.02 | UT-020, UT-023 | Covered | |
| US1.2 | 2 | Rules are produced | UT-003, UT-004 | Covered | |
| US1.2 | 3 | A rule is retained only when support ≥ 0.02, confidence ≥ 0.50 and lift ≥ 1.20 | UT-003, UT-005, UT-019, UT-020 | Covered | Was a Mismatch (0.03) until the new engine. The engine adds two more gates not in the AC: at least 20 requests per rule (UT-024) and at most 4 products (UT-025) |
| US1.2 | 4 | Retained rules are banded Strong / Moderate / Weak using the documented thresholds | UT-009, UT-010 | Mismatch | The story's remark gives Strong 0.08 / 0.55 / 1.50 and Moderate 0.04 / 0.40 / 1.20 (support / confidence / lift). The code uses Strong = confidence ≥ 0.70 and support ≥ 0.05, Moderate = confidence ≥ 0.60 and support ≥ 0.03, and does not use lift for the band. The tests check the code's bands; update the story remark |
| US1.2 | 5 | Every retained row has antecedent, consequent, support, confidence, lift and strength | UT-007, UT-011 | Covered | |
| US1.4 | 1 | Sample data minimally supports association rule mining | — | Not covered | Outside the UC1 suites. Evidence exists in `scripts/sim/check.py` (checks the simulated requests and whether the planted bundles are recovered) and `scripts/sim/score_uc1.py`; record its output as evidence |
| US1.4 | 2 | Order, orderline, product and inventory data link to each other | — | Not covered | Could be checked with foreign-key / orphan-row SQL queries; none exist in `tests/` yet |
| US1.5 | 1 | Retained rules are written to `productrelationship` for WH-CENTRAL | UT-011, UT-014, UT-018 | Covered | Stored under the label `WH001` (the story says WH-CENTRAL), plus one rule set per subsidiary |
| US1.5 | 2 | Re-running on the same data with the same parameters gives the same rule set | UT-021 | Covered | |
| US1.5 | 3 | Run metadata records execution time, thresholds and the number of rules written | UT-023 | Partial | `modelrun` stores the generation timestamp, version and every gate and band. Execution duration and rule count are not stored (the rule count is only returned in `StageResult.output_rows`) |
| US1.6 | 1 | The page loads KPIs, a relationship table and a network graph from `productrelationship` | FT-001, FT-015 | Covered | |
| US1.6 | 2 | The graph shows pairwise SKU relationships in a force-directed layout | FT-001, FT-020 | Covered | Shown as "Product Clusters" |
| US1.6 | 3 | Hovering over a link shows that pair's metrics | FT-021 | Covered | |
| US1.6 | 4 | Searching for an SKU filters both the table and the graph | FT-012, FT-013, FT-031 | Partial | Search works by ID and by name. FT-013 records a defect: a search with no matches shows "No engine output yet" |
| US1.6 | 5 | The table shows antecedent, consequent, itemset size, support, confidence, lift and strength | FT-001, FT-016 | Covered | Shown under business names (US1.13): Primary Product, Frequently Bought With, Bundle Size, Popularity, Reliability, Relationship pattern, Suggestion |
| US1.6 | 6 | Strong and Moderate relationships can be read by UC2 and UC3 after the run | — | Not covered | Cross-use-case check outside the UC1 suites. The code does read them: UC2's page (`live-data.js`, Strong and Moderate only), UC2's reorder check (`scripts/live/day.py`, can-order rule) and UC3 (`engines/uc3/layout.py`). Test it in integration (QA1) |
| US1.6 | 7 | The UI shows stored results and does not recalculate the rules | FT-016 | Covered | |
| US1.7 | 1 | Export downloads only the rows matching the filters | FT-017 | Covered | |
| US1.7 | 2 | The CSV includes warehouse ID, antecedent, consequent, itemset size, support, confidence, lift and strength | FT-017 | Covered | The CSV also includes product names |
| US1.7 | 3 | Exported values match the values in the table | FT-017 | Covered | The table shows percentages and business labels; the CSV keeps raw values. Compare after converting |
| US1.8 | 1 | The analyst can select an individual subsidiary | FT-002 | Covered | |
| US1.8 | 2 | The system displays that warehouse's relationships | FT-002 | Covered | |
| US1.8 | 3 | Relationships are based only on that subsidiary's data | UT-015, UT-026, FT-002 | Covered | |
| US1.8 | 4 | The analyst can identify the products and their relationship strength | FT-002, FT-024, FT-029 | Covered | |
| US1.8 | 5 | A message is shown when no relationships exist | FT-027, UT-012 | Partial | The engine handles a subsidiary with no rules (UT-012). FT-027 is Blocked: every warehouse has rules in the current data |
| US1.8 | 6 | Relationships are recalculated and replaced every 30 days | UT-018 | Covered | Replacement is tested (UT-018). The schedule is `.github/workflows/run-script-UC1.yml`: monthly, on the 15th at 08:00 SGT (checked by inspection, not by an automated test) |
| US1.9 | 1 | The analyst can view relationships aggregated across all subsidiaries | FT-001, UT-014 | Covered | Shown as "Product combination shared across all warehouse" (WH001) |
| US1.9 | 2 | Relationships are shown with their strength and frequency | FT-001, FT-015 | Covered | |
| US1.9 | 3 | The data represents patterns across all subsidiaries | UT-014, UT-015, FT-015 | Covered | |
| US1.9 | 4 | The analyst can identify commonly associated products and overall trends | FT-001, FT-010 | Covered | |
| US1.9 | 5 | A message is shown when no relationships exist | FT-027 | Partial | Same as US1.8 AC5 |
| US1.9 | 6 | Relationships are recalculated and replaced every 30 days | UT-018 | Covered | Same as US1.8 AC6 |
| US1.10 | 1 | Filter by strength (Strong, Moderate, Weak) | FT-010 | Covered | The filter is now called Suggestion: Best Bundle, Recommended Bundle, Consider Bundle |
| US1.10 | 2 | Filter by itemset size | FT-011 | Covered | Called Bundle size |
| US1.10 | 3 | The table paginates large results | FT-014 | Covered | |
| US1.10 | 4 | Filters apply to both the table and the graph | FT-010, FT-011 | Covered | |
| US1.11 | 1 | Multiple warehouses can be selected with checkboxes in a dropdown | FT-005, FT-006 | Covered | |
| US1.11 | 2 | Selecting Central Hub disables the subsidiary checkboxes | FT-003 | Covered | |
| US1.11 | 3 | Selecting a subsidiary disables Central Hub | FT-004 | Covered | |
| US1.11 | 4 | A "Select all Subsidiary Hospitals" option exists | FT-005 | Covered | Now labelled "Select all Subsidiary Warehouse" |
| US1.11 | 5 | An info icon tooltip explains the selection logic | FT-009 | Covered | |
| US1.11 | 6 | The table includes a Warehouse column | FT-001, FT-006 | Covered | |
| US1.11 | 7 | The graph shows each SKU pair once, using the highest support, confidence and lift | FT-026 | Covered | |
| US1.12 | 1 | Hovering over a product ID shows its name | FT-024 | Covered | |
| US1.12 | 2 | An info icon appears beside each metric header | FT-025 | Covered | |
| US1.12 | 3 | Hovering over the icon explains the metric | FT-025 | Covered | |
| US1.13 | 1 | The main chart and table do not display Support, Confidence or Lift as primary labels | FT-028 | Covered | |
| US1.13 | 2 | Results use business-friendly terms with simple explanations | FT-025, FT-028 | Covered | The page uses Popularity, Reliability and Relationship pattern rather than the story's examples ("How Often Ordered Together", "Likelihood of Being Ordered Together"); the meaning is the same |
| US1.13 | 3 | Each relationship has an easy strength level | FT-010, FT-029 | Covered | Suggestion labels are Best Bundle / Recommended Bundle / Consider Bundle |
| US1.13 | 4 | A short plain-English insight for each important relationship | — | Not implemented | The page has a general subtitle and the graph's "How to read this graph" help (FT-030), but no per-relationship sentence |
| US1.13 | 5 | A suggested business action where relevant | FT-029 | Partial | The Suggestion label is the action, and the subtitle mentions replenishment and slotting. There is no per-relationship action such as "review together for replenishment" |
| US1.13 | 6 | Each business-facing metric is explained by an info icon or tooltip | FT-025, FT-030 | Covered | |
| US1.13 | 7 | Support, Confidence and Lift stay available in a details view or tooltip | FT-016, FT-017 | Partial | The raw values (support, confidence, lift, strength) are in the CSV export. On the page they appear only under their business names; no view shows the technical names |
| US1.13 | 8 | The new presentation uses the same stored results and does not change the UC1 calculation | FT-016 | Covered | |

## Summary

| Status | Number of ACs |
|---|---|
| Covered | 44 |
| Partial | 7 |
| Mismatch | 2 |
| Not implemented | 2 |
| Not covered | 3 |
| **Total** | **58** |

Tests not tied to a story: UT-008, UT-016, UT-017, FT-022 and FT-023 (robustness checks).

## Decisions for the team

1. **US1.1 AC1–2:** reword "order" / "central-to-subsidiary order history" to "hospital request" / "hospital requests from the last 90 days", or switch the engine back to orders.
2. **US1.2 AC4:** update the band remark to the code's bands (Strong confidence ≥ 0.70 and support ≥ 0.05; Moderate confidence ≥ 0.60 and support ≥ 0.03; lift is a gate only), or change the code.
3. **US1.5 AC1:** "WH-CENTRAL" is stored as `WH001`.
4. **FT-013 defect:** a search with no matches shows "No engine output yet". Give the page its own "no matches" message.
5. **US1.13 AC4, AC5, AC7:** decide whether per-relationship insights and actions, and a technical details view, are still in scope for Sprint 4.
