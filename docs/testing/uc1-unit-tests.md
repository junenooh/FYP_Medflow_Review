# UC1 Unit Test Cases — Association Rule Mining (FP-Growth)

**Module under test:** `engines/uc1/arm_jeremiahVer.py` (the engine exported by `engines/uc1/__init__.py` and run monthly by `.github/workflows/run-script-UC1.yml`)
**Test file:** `tests/engines/test_uc1_arm.py`
**Tool:** pytest 9.1 · Python 3.14 · mlxtend 0.25 · pandas 3.0
**How to run:** `python -m pytest tests/engines -v`
**Last run:** 2026-10-19 — 32 passed, 0 failed (26 test cases; UT-009 covers 7 inputs)
**Evidence:** [evidence/uc1-2026-10-19/unit](evidence/uc1-2026-10-19/README.md) (pytest output and mutation results)

> `engines/uc1/arm.py` is the earlier engine (fulfilled CW → SW orders, different bands). It is no longer run, so it is
> no longer tested. The test cases below were rewritten on 2026-10-19 for the current engine.

The unit tests call each engine function directly with small, hand-built request data. They do not use the
Supabase database, the browser, or the login. The database connection is replaced with a mock object
wherever a function would normally read from it or write to it.

## What the current engine does (the behaviour under test)

| Setting | Value | Where |
|---|---|---|
| Basket | One **hospital request** (`stocktransfer` + `stocktransferline`); requests with fewer than 2 different products are dropped | `load_transactions`, `build_basket_matrix` |
| Data window | The last **90 days**, counted back from the latest request in the table | `LOOKBACK_DAYS` |
| Scopes | All subsidiaries together (stored as `WH001`), then each subsidiary on its own | `run` |
| Gates (a rule must pass all) | support ≥ **0.02**, confidence ≥ **0.50**, lift ≥ **1.20**, seen on at least **20** requests, at most **4** products, exactly 1 consequent | `mine_rules` |
| Strength | **Strong**: confidence ≥ 0.70 and support ≥ 0.05 · **Moderate**: confidence ≥ 0.60 and support ≥ 0.03 · **Weak**: passes the gates only. Lift is a gate, not a grade | `classify` |
| Run record | `modelrun` row with version `FP-GROWTH-3.0-gated` and every setting above in `parametersignature` | `write_all_scopes` |

## Shared test data (SAMPLE_REQUESTS)

The 11 requests below, each repeated **10 times**: 110 requests, 100 baskets with 2 or more products.
Repeating keeps every ratio the same while clearing the 20-request minimum per rule.

| Request | Products | Request | Products |
|---|---|---|---|
| R1, R2, R3 | A, B | R7, R8 | D, E |
| R4 | A, B, C | R9 | C, D |
| R5 | A, C | R10 | B, E |
| R6 | B, C | R11 | F (single item) |

Hand calculation over the 100 baskets:

| Rule | Support | Confidence | Lift | Requests | Passes the gates? | Strength |
|---|---|---|---|---|---|---|
| A → B | 40/100 = 0.40 | 40/50 = 0.80 | 0.80 / 0.60 = 1.33 | 40 | Yes | Strong |
| B → A | 0.40 | 40/60 = 0.67 | 0.67 / 0.50 = 1.33 | 40 | Yes | Moderate |
| D → E | 20/100 = 0.20 | 20/30 = 0.67 | 0.67 / 0.30 = 2.22 | 20 | Yes | Moderate |
| E → D | 0.20 | 0.67 | 2.22 | 20 | Yes | Moderate |
| A → C | 0.20 | 20/50 = 0.40 | 1.00 | 20 | No (confidence) | — |
| C → A | 0.20 | 20/40 = 0.50 | 1.00 | 20 | No (lift) | — |
| Every other pair | ≤ 0.10 | | | ≤ 10 | No (fewer than 20 requests) | — |

## Test cases

The **User Story** column uses the backlog IDs (see `uc1-traceability.md`).

| Test Case ID | User Story | Test Scenario | Pre-conditions | Test Steps | Test Data | Expected Result | Test Status | Remarks |
|---|---|---|---|---|---|---|---|---|
| TC-UC1-UT-001 | US1.1 | Verify that a product on several lines of the same request is counted once | Request data built in memory | 1. Call `build_basket_matrix(txns)` 2. Read row R1 3. Look for R2 | R1: A, A, B; R2: C, C | R1 basket = {A: True, B: True}; R2 is dropped (one product on two lines is still a single-item request) | Pass | Added on 2026-10-19 after mutation testing (bug M7) |
| TC-UC1-UT-002 | US1.1 | Verify that requests with only one product are excluded from mining | Base requests loaded | 1. Call `build_basket_matrix(txns)` 2. Check the rows that come back | The 11 base requests (R11 = F only) | R11 is not present; 10 baskets remain | Pass | NIL |
| TC-UC1-UT-003 | US1.2 | Verify that only rules passing every gate are generated | SAMPLE_REQUESTS loaded | 1. Build the basket matrix 2. Call `mine_rules(baskets)` | SAMPLE_REQUESTS, default settings | Exactly 4 rules: A→B, B→A, D→E, E→D | Pass | NIL |
| TC-UC1-UT-004 | US1.2 | Verify that support, confidence and lift match the hand calculation | SAMPLE_REQUESTS loaded | 1. Call `mine_rules` 2. Read the A→B and D→E metrics | SAMPLE_REQUESTS | A→B: 0.40 / 0.80 / 1.33; D→E: 0.20 / 0.67 / 2.22 | Pass | NIL |
| TC-UC1-UT-005 | US1.2 | Verify that rules with low confidence or low lift are filtered out | SAMPLE_REQUESTS loaded | 1. Call `mine_rules` 2. Look for A→C and C→A | A→C confidence 0.40; C→A lift 1.00 | Neither rule is returned | Pass | NIL |
| TC-UC1-UT-006 | US1.2 | Verify that the gates can be changed | SAMPLE_REQUESTS loaded | 1. Call `mine_rules(baskets, baseline_confidence=0.70)` | Confidence gate 0.70 | Only A→B (confidence 0.80) is returned | Pass | NIL |
| TC-UC1-UT-007 | US1.2 | Verify that rules with more than one consequent are excluded (the schema stores a single consequent) | Request data built in memory | 1. Build the baskets 2. Call `mine_rules` 3. Check consequent sizes | 50 × {X, Y, Z}, 50 × {P, Q} | Rules are returned; every rule has exactly 1 consequent (X → {Y, Z} is dropped) | Pass | NIL |
| TC-UC1-UT-008 | — | Verify that an empty basket matrix does not crash mining | None | 1. Call `mine_rules(pd.DataFrame())` | Empty DataFrame | An empty result is returned with no error | Pass | Robustness check |
| TC-UC1-UT-009 | US1.2 | Verify that rule strength follows the confidence and support bands | None | 1. Call `classify(support, confidence, lift)` for each input | (0.05, 0.70, 1.20); (0.049, 0.70, 1.20); (0.05, 0.699, 1.20); (0.03, 0.60, 1.20); (0.029, 0.60, 1.20); (0.03, 0.599, 1.20); (0.02, 0.50, 1.20) | Strong; Moderate; Moderate; Moderate; Weak; Weak; Weak | Pass | Exact boundaries and the values just below them, for both bands |
| TC-UC1-UT-010 | US1.2 | Verify that lift does not change the strength (it is only a gate) | None | 1. Call `classify` with lift 1.21 and with lift 15.0, keeping support and confidence the same | (0.10, 0.80, ·); (0.04, 0.65, ·) | Strong for both lifts; Moderate for both lifts | Pass | Replaces the old "weakest metric decides" test, which no longer applies |
| TC-UC1-UT-011 | US1.2, US1.5 | Verify that a mined rule is converted into correctly linked database rows | One rule built in memory | 1. Call `rules_to_rows(rules, "WH002", "run-1", 25)` | {C, A} → {B}, support 0.10, confidence 0.75, lift 1.60 | Relationship row: WH002, consequent B, itemset size 3, "Strong", order count 25, FP-GROWTH, run-1; antecedent rows (id, A), (id, C) with the same id | Pass | Antecedents are stored in sorted order |
| TC-UC1-UT-012 | US1.1, US1.8 | Verify that a subsidiary whose requests all have a single item produces no rules without crashing | Request data built in memory | 1. Call `mine_scope(txns, "WH005", "run-1")` | R1: A; R2: B | No rules; request count 2; basket count 0 | Pass | NIL |
| TC-UC1-UT-013 | US1.1 | Verify that the request count includes every request and the basket count only multi-product requests | SAMPLE_REQUESTS loaded | 1. Call `mine_scope(txns, "WH002", "run-1")` | SAMPLE_REQUESTS (110 requests) | Request count = 110; basket count = 100 | Pass | NIL |
| TC-UC1-UT-014 | US1.1, US1.5, US1.9 | Verify that a full run mines the network scope and each subsidiary | Database connection, extract and load are mocked | 1. Call `run()` 2. Check the scopes passed to the write step | WH002: 40 × {A, B}, 40 × {C, G}; WH003: 40 × {D, E}, 40 × {H, K} | Scopes WH001, WH002, WH003 are written; status "success"; input rows = 160 | Pass | WH001 is the label for all subsidiaries' requests together |
| TC-UC1-UT-015 | US1.8, US1.9 | Verify that subsidiary rules are mined only from that subsidiary's own requests | Same as UT-014 | 1. Call `run()` 2. Check the products and order count in each scope | Same as UT-014 | WH002 rules use only A, B, C, G (order count 80); WH003 rules use only D, E, H, K; WH001 uses all products (order count 160) | Pass | `ordercount` holds the number of requests mined |
| TC-UC1-UT-016 | — | Verify that a single-subsidiary run does not touch the network scope | Same as UT-014 | 1. Call `run("WH002")` | WH002 requests only | Only the WH002 scope is written | Pass | Manual debug mode |
| TC-UC1-UT-017 | — | Verify that a run with no request lines fails gracefully | Same as UT-014 | 1. Call `run()` | No requests | Status "failed"; the error says "No hospital request lines found"; nothing is written | Pass | Robustness check |
| TC-UC1-UT-018 | US1.5, US1.8, US1.9 | Verify that rules are saved per scope inside one database transaction | Mock connection | 1. Call `write_all_scopes(conn, scopes, "run-1")` 2. Check the SQL that was issued | WH001 with 1 rule; WH002 with no rules | One transaction; modelrun is inserted first; old rules are deleted for both WH001 and WH002; rows are inserted only for WH001 | Pass | An empty scope still clears its outdated rules |
| TC-UC1-UT-019 | US1.2 | Verify that a rule with confidence between 0.40 and 0.50 is rejected by the 0.50 gate | Request data built in memory | 1. Call `mine_rules(baskets)` 2. Call `mine_rules(baskets, baseline_confidence=0.40)` | 40 × {X, Y}, 50 × {X, Z}, 110 × {P, Q} (X→Y confidence 0.444, lift 2.22) | Step 1: X→Y is not returned. Step 2: X→Y is returned, which proves confidence is the only reason it was rejected | Pass | Mutation bug M1 |
| TC-UC1-UT-020 | US1.2 | Verify that a rule with support below 0.02 is rejected | Request data built in memory | 1. Call `mine_rules(baskets)` 2. Call `mine_rules(baskets, min_support=0.01, baseline_support=0.01)` | 30 × {X, Y}, 1,970 × {P, Q} (X→Y support 0.015, on 30 requests) | Step 1: X→Y is not returned. Step 2: X→Y is returned | Pass | 2,000 baskets, so the 20-request minimum is met and only the support gate rejects the rule |
| TC-UC1-UT-021 | US1.5 | Verify that re-running on the same data gives the same rule set | SAMPLE_REQUESTS loaded | 1. Call `mine_scope` twice on the same data 2. Compare the rows, ignoring the random relationship ID and the date | SAMPLE_REQUESTS | Both runs return identical rules, metrics and strengths | Pass | NIL |
| TC-UC1-UT-022 | US1.1 | Verify that only the last 90 days of hospital requests are extracted | Mock connection streaming two request lines | 1. Call `load_transactions(conn)` 2. Check the SQL, parameters and result | Default settings | The query reads `stocktransferline` joined to `stocktransfer`, counts 90 days back from `max(transferdate)`, parameters = [90]; the result has columns orderid, productid, warehouseid and 2 rows | Pass | Replaces the old "fulfilled orders only" test |
| TC-UC1-UT-023 | US1.2, US1.5 | Verify that the run record stores the data source, gates and bands | Mock connection | 1. Call `write_all_scopes` 2. Read the modelrun insert | run-1 | modelrun has run ID run-1, type "Association Rule Mining", a generation timestamp, version FP-GROWTH-3.0-gated and the signature `source=stocktransfer;lookback_days=90;min_support=0.02;support>=0.02;confidence>=0.5;lift>=1.2;min_pair_count=20;max_len=4;strong=conf>=0.7&sup>=0.05;moderate=conf>=0.6&sup>=0.03;scopes=1` | Pass | The rule count and execution duration are not stored in modelrun |
| TC-UC1-UT-024 | US1.2 | Verify that a rule seen on fewer than 20 requests is rejected | Request data built in memory | 1. Call `mine_rules(baskets)` 2. Call `mine_rules(baskets, min_pair_count=10)` | 19 × {X, Y}, 21 × {P, Q} (X→Y support 0.475, confidence 1.0, on 19 requests) | Step 1: X→Y is not returned. Step 2: X→Y is returned | Pass | New on 2026-10-19 (gate added by the new engine) |
| TC-UC1-UT-025 | US1.2 | Verify that rules contain at most 4 products | Request data built in memory | 1. Call `mine_rules(baskets)` 2. Check antecedent + consequent sizes | 30 × {A, B, C, D, E}, 30 × {P, Q} | Rules are returned; the largest rule has exactly 4 products (no 5-product rule) | Pass | New on 2026-10-19 |
| TC-UC1-UT-026 | US1.8 | Verify that a single-subsidiary extract filters by that subsidiary | Mock connection streaming nothing | 1. Call `load_transactions(conn, source_warehouse_id="WH002")` | WH002 | The query filters `t.sourcewarehouseid = %s`; parameters = ["WH002", 90]; an empty result comes back without error | Pass | New on 2026-10-19 |

## Verifying test accuracy (mutation testing)

To confirm that the tests detect real defects, deliberate bugs were introduced into `arm_jeremiahVer.py` one at a
time, the suite was run, and the original code was restored (run on 2026-10-19). A test suite is accurate if it
fails for each bug that changes behaviour.

| ID | Injected bug | Result | Caught by |
|---|---|---|---|
| M1 | Confidence gate 0.50 → 0.40 | Caught | UT-019, UT-023 |
| M2 | Strong confidence band 0.70 → 0.69 | Caught | UT-009, UT-023 |
| M3 | Band comparison `>=` changed to `>` | Caught | UT-009 |
| M4 | Strong also requires lift ≥ 1.5 | Caught | UT-009, UT-010 |
| M5 | Single-item requests kept in the baskets | Caught | UT-002, UT-004, UT-012, UT-013 |
| M6 | Multi-item consequents allowed | Caught | UT-007 |
| M7 | Duplicate product lines not removed | Caught (after UT-001 was extended) | UT-001 |
| M8 | Subsidiary scopes not mined | Caught | UT-014, UT-015 |
| M9 | Support gate 0.02 → 0.01 | Caught | UT-023 |
| M10 | Minimum requests per rule 20 → 19 | Caught | UT-023, UT-024 |
| M11 | Itemset cap 4 → 5 | Caught | UT-023, UT-025 |
| M12 | 90-day window removed | Caught | UT-022, UT-023, UT-026 |
| M13 | Lift gate removed from the final filter | Not caught: equivalent mutant | `association_rules` already drops rules below lift 1.20 one step earlier, so behaviour does not change |
| M14 | Moderate support band 0.03 → 0.02 | Caught | UT-009, UT-023 |

Score: 13 of 13 non-equivalent bugs detected. M7 at first went undetected: without the duplicate removal, a
request that lists one product on two lines counted as a 2-product basket, so UT-001 was extended to check that
such a request is dropped. M9 is caught only by the run record (UT-023), because mining also starts at 0.02
support, so lowering the final gate alone does not change the rules.

## User stories without unit tests

The unit tests cover the Python engine only. The following UC1 stories have no unit tests, for the reasons below;
each is covered at another test level, or the gap is recorded in `uc1-traceability.md`.

| User Story | Reason there is no unit test | Covered by |
|---|---|---|
| US1.4 Sample data quality | This story is about the generated dataset in Supabase, not engine code. It needs data-validation checks (orphan request lines, unknown products) | Not covered by the UC1 suites (see `uc1-traceability.md`) |
| US1.6 Table and network graph | The page's behaviour (loading, search, hover, highlight) happens in the browser and depends on the DOM and the live data | Functional tests FT-001, 012, 013, 015, 016, 018–021, 031 |
| US1.7 Export results | Downloading a filtered CSV is a browser action | Functional test FT-017 |
| US1.10 Recommendation and bundle-size filters | Filtering and pagination are user interactions on the page | Functional tests FT-010, 011, 014 |
| US1.11 Multiple-warehouse selection | The checkbox enable/disable rules, "Select all" and the tooltip are user interactions | Functional tests FT-003–009, 026 |
| US1.12 Product names and metric meanings | Hover tooltips can only be checked visually in the browser | Functional tests FT-024, 025 |
| US1.13 Business-friendly language | Labels and wording are checked on the page | Functional tests FT-028–030 |

**Why there are no frontend unit tests yet:** the UC1 page (`client/src/features/uc1-relationships/`) has no
JavaScript test framework set up, and most of its helper functions are private to their modules (not exported).
`recommendationLabel` in `labels.js` is exported and could be unit tested first. Others could be exported later and
tested with a tool such as Vitest:

| Function | Story | What a unit test would prove |
|---|---|---|
| `recommendationLabel` (`labels.js`) | US1.13 | Strong → "Best Bundle", Moderate → "Recommended Bundle", Weak → "Consider Bundle" |
| `confidenceLabel`, `supportLabel`, `liftLabel` (`labels.js`) | US1.13 | Reliability, popularity, and relationship-pattern values map to the documented business labels, including each threshold boundary |
| `uniquePairCount` (`index.js`) | US1.6 | The Unique Product Combination KPI counts A→B and B→A as one pair |
| `buildGraph` (`charts/network.js`) | US1.11 | When several warehouses share a pair, the graph keeps the highest support, confidence and lift |
| `toCsv` (`index.js`) | US1.7 | The CSV has the right columns, and commas and quotes are escaped |
| `paginationItems` (`index.js`) | US1.10 | Page numbers and "..." are correct at the first, middle and last pages |

Until then, this behaviour is verified by the functional tests listed above.

## Out of scope for unit testing

- The real Supabase connection and the `load_transactions` query against live data. These need a live database, so they belong in integration testing.
- The correctness of the mlxtend FP-Growth algorithm itself, which is a third-party library.
- The UC1 frontend (`client/src/features/uc1-relationships/`), which belongs in frontend testing.
