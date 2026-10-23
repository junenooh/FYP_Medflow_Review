# MedFlow simulator (`scripts/sim`)

Builds a year of hospital demand and Central → subsidiary replenishment against the **real master
data** (products, packaging, warehouses, bins, zones, hospitals) and loads it into the tables the
simulator owns. Nothing else in the database is touched.

## Table rules (product owner, Oct 2026)

The lists live in `scripts/sim/db.py`; every script imports them.

| Rule | Tables | What the scripts do |
|---|---|---|
| Untouched | aisle, bin, product, rack, shelf, storage, user_roles, warehouse, zone | Read only. Never written. |
| Outputs | layoutrecommendation (UC3), modelrun, productrelationship, productrelationshipantecedent (UC1) | Never touched by the simulator. |
| UC2-owned | uc2_settings, uc2_settings_history | Written only by UC2's own tools (`engines/uc2/service_levels.py`, migrate). |
| Not needed | demand, replenishmentrecommendation | Nothing reads or writes them. |
| Replaced by `load` | warehouseproduct, orders, orderline, inventory, stocktransfer, stocktransferline | `TRUNCATE` (no `CASCADE`) and refilled. |
| Emptied by `load` | consumption, uc2_policy_parameters | `replenishment --rebuild --direct` refills them. |
| Insert only | site | New hospitals only (none expected). |

Data rules the loader enforces (it refuses, or rolls back, if any is broken):

- **Products:** exactly `MED0001` … `MED{n}` in every table with a `productid`.
- **Units:** hospitals request **sales packs** (`storage.salespackqty` dosage units each); Central →
  subsidiary order lines are **whole cartons** (`storage.shippingcasepack` packs).
- **Demand:** `product.manualbasedemand` = annual network demand in dosage units, static.
- **Central bins:** every WH001 inventory row names an ACTIVE WH001 bin; **a bin holds one product; a
  product may hold several bins**; the bin is in the zone of the product's velocity class; the stock in
  a bin never exceeds what the bin can hold by carton size and weight, **against the bin table as it
  is**. Subsidiary rows have `binid` NULL.
- **Warehouses:** WH001 central, WH002–WH006 subsidiaries; orders only go to subsidiaries; delivery
  rows carry the order that delivered them.

## Run it (from the repo root)

```bash
python -m scripts.sim.generate --profile full                # reads masters, writes data/sim/full/*.csv
python -m scripts.sim.load --profile full                    # DRY RUN: all checks, writes nothing
python -m scripts.sim.load --profile full --apply --confirm-host <host printed by the dry run>
python -m scripts.sim.check --profile full                   # read-only consistency checks
python -m engines.uc2.migrate                                # UC2 objects, needs uc2-3.3
python -m engines.uc2.service_levels --apply                 # per-product service levels
python -m engines.uc2.replenishment --rebuild --direct       # consumption + SS / ROP / OUL
python -m scripts.sim.score_uc1 --profile full               # after UC1 has run
```

`generate --masters <folder>` reads the masters from CSV exports (`product_rows.csv`,
`storage_rows.csv`, `07_sites.csv`, `08_warehouses.csv`, `09_bins.csv`) instead of the database.
`generate --bin-max-weight-kg 60` plans with a bin weight limit the client has not applied yet; the
loader still checks the data against the bin table, so the real load only passes once the table
is changed.

All scripts use `DATABASE_URL` in `.env.local`. `generate`, `check` and `score_uc1` open read-only
sessions. `load` writes only with `--apply`, and only when `--confirm-host` matches the host.

## What `load --apply` does

One transaction: fingerprint every protected table; `TRUNCATE` the replaced and emptied tables (no
`CASCADE`); add new hospitals; `COPY` the CSVs; re-check the rules in SQL; fingerprint again; commit
only if every check passes and every fingerprint is identical, else roll back. The truncated tables
are locked while the load runs (about five minutes for `full`).

## Profiles and size

| Profile | Products | Days | Request lines | CSV | Database after load |
|---|---|---|---|---|---|
| `dev` | MED0001–MED0200 | 120 | ~0.6 M | ~70 MB | ~200 MB |
| `full` | MED0001–MED1000 | 365 | ~10.8 M | ~1.1 GB | ~2.8 GB |

`end_date: null` in `sim_config.json` means the history ends the day before the run.

## How the data behaves

- **Demand** per product from `manualbasedemand`; a subsidiary's share is its multiplier / 5.25
  (WH002 1.5, WH005 1.25, WH003 1.0, WH004 1.0, WH006 0.5). Requests follow an hourly profile
  (peak 09:00–18:00, near zero 01:00–05:00) and a weekday pattern.
- **Baseline ordering (the history):** subsidiaries review daily against their own reorder point and
  order-up-to level, mis-sized per product (log-normal error, σ 0.35), with ±20% quantity noise and
  10% early / 10% late slips. Written to `warehouseproduct`. UC2 replaces these levels.
- **Cartons:** order the number of cartons nearest to the gap up to the order-up-to level, never fewer
  than it takes to clear the reorder point, at least one.
- **Central:** a max per product in cartons (7 days of dispatch + safety stock at 97%), held in bins in
  the zone of its velocity class. Dispatch draws earliest expiry first (FEFO), one ledger row per bin
  touched; every touched bin is topped back up by the supplier the same evening. Dispatch beyond what
  the bins hold is cross-docked from the supplier: Central never runs out.
- **Planted bundles:** 15 clinically coherent groups (see `sim_config.json`) land on the same hospital
  request together. Each bundle's anchor (its least-requested member) carries the relationship so the
  rule anchor → member reaches its band; the anchor's packs per line are rescaled so its packs/day
  stay on `manualbasedemand`. `check.py` grades every bundle from the data: B01–B05 strong, B06–B10
  moderate, B11–B13 weak, B14–B15 below the gates.
- **`ground_truth.json`** in `data/sim/<profile>/` holds every rate, level, bin and bundle. The same
  seed and config always give identical data.

## UC1 grading (shared with `score_uc1.py`)

Gates: support ≥ 0.02, confidence ≥ 0.50, lift ≥ 1.20. Strong: confidence ≥ 0.70 and support ≥ 0.05.
Moderate: confidence ≥ 0.60 and support ≥ 0.03. Weak: the gates only. Set in `sim_config.json`
under `bundles.bands`; UC1's own thresholds are to be aligned to the same values.
