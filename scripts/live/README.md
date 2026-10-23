# Live day (`scripts/live`)

Adds ONE simulated day on top of the loaded history, reordering with **UC2's** reorder point and
order-up-to level instead of the subsidiaries' own mis-sized levels.

```bash
python -m scripts.live.day                                 # the day after the ledger ends
python -m scripts.live.day --spike 2.5 --warehouse WH002   # a busier day at one subsidiary
python -m scripts.live.day --dry-run                       # work it all out, write nothing
```

| Time | Step | Writes |
|---|---|---|
| 08:00 | Due orders arrive at the subsidiaries | `inventory` (receipt rows, `orderid` set), `orders` → Fulfilled |
| all day | Hospital requests on the hourly profile, served from stock | `stocktransfer`, `stocktransferline` (packs) |
| 23:00 | The day's hand-outs come off the shelf | `inventory` |
| — | UC2 refresh: `python -m engines.uc2.replenishment --direct` | `consumption`, `uc2_policy_parameters` |
| 23:30 | **Reorder check:** on hand + on its way ≤ UC2 ROP → order up to UC2 OUL, in whole cartons, one order per subsidiary. **Companions** (can-order rule): for each of the subsidiary's Strong / Moderate UC1 rules whose antecedents are all among tonight's triggers, the consequent joins the order if its position is at or below ROP + 100% (Strong) / 50% (Moderate) of its safety stock; its order line id ends in `C` | `orders` (Processing), `orderline` |
| 23:45 | Central draws FEFO from each product's bins and tops the bins back up; anything beyond the bins is cross-docked from the supplier | `inventory` (WH001 bin rows) |

Rules: writes only the five tables above (all on the product owner's list); nothing is truncated,
dropped or altered; each write re-checks the table rules and fingerprints the protected tables, and
rolls back on any failure. Each day has its own seed. If a run stops after the hand-outs, the next
run finishes that day's reorder check instead of starting a new day.

The first live day after a rebuild raises large orders: UC2's levels are higher than the mis-sized
baseline for many products, so it tops them up at once (and Central cross-docks what its bins
cannot cover). From the second day the volumes are normal.
