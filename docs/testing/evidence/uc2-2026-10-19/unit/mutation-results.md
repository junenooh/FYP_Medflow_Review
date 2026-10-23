# UC2 mutation testing — 2026-10-19

Each bug was written into the source on its own, the matching suite was run (pytest for the engine, node --test for the page logic), and the original file was restored byte for byte. `git status` confirmed the sources unchanged afterwards.

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

**Score: 20 of 20 bugs detected.** M7 and M14 survived the first run; UT-012 and UT-104 were extended to catch them.
