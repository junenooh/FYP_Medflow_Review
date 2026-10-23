# UC1 mutation testing — 2026-10-19

Engine: `engines/uc1/arm_jeremiahVer.py`. Each bug was written into the engine on its own, the unit suite
(`python -m pytest tests/engines`) was run, and the original file was restored (confirmed unchanged with `git status`).

| ID | Injected bug | Result | Failing tests |
|---|---|---|---|
| M1 | Confidence gate 0.50 → 0.40 | Caught | UT-019, UT-023 |
| M2 | Strong confidence band 0.70 → 0.69 | Caught | UT-009, UT-023 |
| M3 | Band comparison `>=` changed to `>` | Caught | UT-009 |
| M4 | Strong also requires lift ≥ 1.5 | Caught | UT-009, UT-010 |
| M5 | Single-item requests kept in the baskets | Caught | UT-002, UT-004, UT-012, UT-013 |
| M6 | Multi-item consequents allowed | Caught | UT-007 |
| M7 | Duplicate product lines not removed | Caught (after UT-001 was extended; missed on the first run) | UT-001 |
| M8 | Subsidiary scopes not mined | Caught | UT-014, UT-015 |
| M9 | Support gate 0.02 → 0.01 | Caught | UT-023 |
| M10 | Minimum requests per rule 20 → 19 | Caught | UT-023, UT-024 |
| M11 | Itemset cap 4 → 5 | Caught | UT-023, UT-025 |
| M12 | 90-day window removed | Caught | UT-022, UT-023, UT-026 |
| M13 | Lift gate removed from the final filter | Not caught: equivalent mutant (rule generation already drops lift below 1.20) | — |
| M14 | Moderate support band 0.03 → 0.02 | Caught | UT-009, UT-023 |

**Score: 13 of 13 non-equivalent bugs detected.**
