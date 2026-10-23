> **Update, 14 October 2026 (rebuild on the final 1,000 products).** The simulator now builds a year of
> history on the real product, storage, bin and zone tables: demand from `product.manualbasedemand`,
> hospital requests in sales packs, Central → subsidiary orders in whole cartons, Central stock held
> per bin (one product per bin, several bins per product, FEFO), a mis-sized baseline ordering policy
> for UC2 to improve on, and 15 clinically coherent planted bundles graded by the agreed UC1 bands.
> UC2 gained per-product service levels (`engines/uc2/service_levels.py`, `uc2-3.3`) and a `--direct`
> rebuild over the database connection. **`scripts/sim/README.md` and `scripts/live/README.md` are
> the current guides.** The client must raise `bin.maxweightkg` to 60 kg before the full load passes.

> **Update, October 2026.** The simulator now runs against the shared database and follows
> the product owner's table rules: it reads the real products (MED0001…), warehouses, bins and
> hospitals, and writes only warehouseproduct, orders, orderline, inventory, stocktransfer,
> stocktransferline (+ new sites, and it empties consumption / uc2_policy_parameters).
> Sections 2, 4, 5 and 6 below describe the old local-only version: the local schema
> (`sql/sim/`), the invented catalogue (`catalog.py`) and `load --reset` no longer exist.
> **`scripts/sim/README.md` is the current guide.**

# MedFlow – local simulated database: handover

This package builds a **realistic MedFlow database on your own machine**. It lets UC1 / UC2 / UC3
be developed and tested without touching the shared Supabase project. Nothing in here changes the
live database.

## Why this exists

The live data had problems that made testing meaningless:

- Stock levels had no relation to demand: about 48 years of cover, so nearly every SKU was flagged
  overstock.
- Orders arrived the same day, while the config said a 5-day lead time.
- The ledger had rows dated in the future, left over from several reloads.

It also had a design problem. UC1 mined CW → SW orders. Once UC2 places those orders, the rules
would only rediscover UC2's own behaviour, a self-fulfilling loop.

The simulator produces one consistent history instead, day by day:

- hospitals request stock from their subsidiary warehouse (SW)
- the SW hands out what it has
- when stock (on hand + in transit) falls to the reorder point, the SW orders from the central
  warehouse (CW)
- the order arrives 1–3 days later

UC1 now mines the **hospital requests** (real demand), not the orders.

---

## 1. What's in the package

| Path | What it is |
|---|---|
| `HANDOVER.md` | This file |
| `scripts/sim/sim_config.json` | Every simulation setting (SKU tiers, warehouse demand, bundles, lead time, initial ROP rule, sizes) |
| `scripts/sim/catalog.py` | Product names, the named "anchor" products and the 10 planted product bundles |
| `scripts/sim/generate.py` | The simulation. Writes CSV files + `ground_truth.json` to `data/sim/<profile>/`. No database needed |
| `scripts/sim/load.py` | Loads the CSVs into a **local** database. Refuses to run against anything that isn't localhost |
| `scripts/sim/check.py` | Read-only checks that the loaded data is consistent and behaves as configured |
| `scripts/sim/score_uc1.py` | Read-only: compares UC1's rules against the planted bundles |
| `scripts/sim/README.md` | Short version of this file |
| `sql/sim/001_local_tables.sql` | Local schema part 1: bare tables |
| `sql/sim/002_local_constraints.sql` | Local schema part 2: keys, foreign keys, indexes (added after loading) |
| `sql/uc2/uc2_setup.sql` | UC2 database objects (v uc2-3.1), with a fix for older policy tables |
| `engines/uc2/*.py` | UC2 engine (`migrate`, `replenishment`, `backtest`, `version`) |
| `engines/uc1/arm_jeremiahVer.py` | UC1 rewritten to mine hospital requests (see section 7) |

Not included on purpose: `.env.local` (contains keys/passwords), and `data/sim/` (generated
output, up to 2.1 GB; you regenerate it in a minute or two).

---

## 2. One-time setup (local Supabase)

The database runs in Docker on your machine. You need the Supabase stack, not just Postgres,
because `replenishment.py` talks to the database through Supabase's REST API.

1. Install and open **Docker Desktop**.
2. Install the Supabase CLI: `brew install supabase/tap/supabase`
3. In the repo folder: `supabase init` (once), then `supabase start`. The first start downloads
   several GB. Later starts take seconds.
4. Run `supabase status -o env` and copy `SERVICE_ROLE_KEY` and `ANON_KEY` (the `eyJ…` values).
5. **Keep your cloud settings aside:** `mv .env.local .env.cloud`. Then create a new
   `.env.local`, each setting on its own line:

   ```
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
   SUPABASE_URL=http://127.0.0.1:54321
   SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
   VITE_SUPABASE_URL=http://127.0.0.1:54321
   VITE_SUPABASE_ANON_KEY=<ANON_KEY>
   ```

   These local keys are the same on every install and only work on your machine.

6. **Check it points at your machine** (prints hosts only, no secrets). Every line should show
   `127.0.0.1`:

   ```bash
   python -c "from dotenv import dotenv_values as d;from urllib.parse import urlparse as u;e=d('.env.local');[print(k,'->',u(v).hostname) for k,v in e.items() if v and '://' in v]"
   ```

7. Switching back to the live project later: `mv .env.local .env.sim && mv .env.cloud .env.local`.

**Safety:**

- `generate` never connects to a database.
- `load`, `check` and `score_uc1` refuse any non-local `DATABASE_URL`.
- `migrate`, `replenishment` and `arm` have **no such guard**. They use whatever `.env.local`
  points at, so do the check in step 6 before running them.

Browse the local tables at **http://127.0.0.1:54323** (Studio). Studio has no login, and the
services are reachable from your Wi-Fi network, so run `supabase stop` on public Wi-Fi. Data is
kept between stops.

---

## 3. Config changes needed

`shared_config.json` → `replenishment`, to match the simulation. Change the existing keys; don't
add duplicates, and don't leave a trailing comma after the last one:

```json
"lead_time_days": 2,
"lead_time_std_days": 0.45,
"ledger_through": "2026-09-27",
```

`requirements.txt`: pin **`mlxtend==0.23.1`**. Versions 0.23.2–0.23.4 have a pure-Python loop in
FP-Growth that takes hours on this data. 0.24+ need Python ≥ 3.11.

```bash
python -m pip install "mlxtend==0.23.1"
```

Also add `data/sim/` to `.gitignore`.

---

## 4. Running it (from the repo root)

```bash
python -m scripts.sim.generate --profile dev        # write CSVs + ground_truth.json
python -m scripts.sim.load --profile dev --reset    # DROP + recreate the local tables, load
python -m scripts.sim.check --profile dev           # consistency checks (all should PASS)
python -m engines.uc2.migrate                        # UC2 functions/tables -> uc2-3.1
python -m engines.uc2.replenishment --rebuild        # consumption + SS / ROP / OUL
python -m engines.uc1.arm_jeremiahVer                # UC1 rules from hospital requests
python -m scripts.sim.score_uc1 --profile dev        # UC1 rules vs planted bundles
```

| Profile | Size | generate | load | check | UC2 rebuild | UC1 |
|---|---|---|---|---|---|---|
| `dev` | 200 SKUs × 120 days | ~10 s | ~15 s | ~10 s | ~1–2 min | ~25 s |
| `full` | 2,000 SKUs × 450 days (~21M request lines, 2.1 GB CSV) | ~2 min | ~5 min | ~4 min | ~15 min | ~2 min |

Use `dev` while developing. Only `full` gives meaningful UC1 results: with 200 products, every
busy item is on so many requests that the planted relationships are diluted.

`load --reset` empties **everything** in the local database, including UC1/UC2 output. Re-run
`replenishment --rebuild` and `arm` afterwards.

---

## 5. What the simulated data looks like

**Warehouses:**

- WH001 is the central warehouse. It ships every order the same evening and is topped up by a
  supplier, so it never runs out.
- WH002–WH006 are subsidiaries, each serving 4–6 hospitals (`site` table).
- Demand multipliers: **WH002 1.5, WH005 1.25, WH003 1.0, WH004 1.0, WH006 0.5.** A slower
  warehouse gets both fewer and smaller requests.

**Products in five demand tiers.** Share of SKUs, units/day at a 1.0 warehouse, and how often
they're requested:

| Tier | Share | Units/day | Requested on |
|---|---|---|---|
| Super High | 7.5% | 250–400 | every day |
| High | 17.5% | 120–250 | every day |
| Medium | 50% | 50–120 | every day |
| Low | 17.5% | 10–50 | ~60–80% of days |
| Very Low | 7.5% | 1–10 | ~15–30% of days, in lumps |

Oncology drugs are always Low or Very Low. There's also a mild weekly pattern (weekends are
quieter).

**Hospital requests:**

- About 12 lines per request.
- Unrelated products share a request only by chance.
- **10 planted bundles** land on the same request together, more often than chance but not
  always. Examples: IV cannula + giving set + saline; syringe + needle + alcohol swab; catheter +
  drainage bag; suture kit + gauze + dressing; gloves + mask; cisplatin + ondansetron + saline.
  They come in strong, medium and weak strengths.
- If a subsidiary is short of stock, it hands out what it has; requested vs issued is recorded.

**Ordering before UC2 (deliberately naive):**

- ROP = 4.5 days and OUL = 15 days of **network-average** demand: the same number of units at
  every subsidiary, not warehouse-specific.
- Reorder when on hand + in transit ≤ ROP, ordering up to OUL.
- Lead time is 1 / 2 / 3 days with probabilities 10 / 80 / 10 (mean 2.0, SD 0.45).

Result: busy WH002 runs close to the edge and slow WH006 sits on too much stock. That's the gap
UC2's warehouse-specific policy should close. Orders still on the road at the end stay
"Processing", i.e. in transit.

**`ground_truth.json`** (in `data/sim/<profile>/`) holds the true rate of every SKU, the
multipliers, the bundles, the lead-time distribution and the seed. The same seed and config
always produce identical data.

---

## 6. Schema differences from the live project (team decision needed before going live)

The local schema matches `sql/schema/001_schema.sql` except for:

1. **`stocktransfer` is repurposed for SW → hospital hand-outs**, which are instant:
   - destination is a hospital (`siteid` → `site`), not `destinationwarehouseid`
   - the unique `orderid` link is dropped
   - `transferdate` is a `timestamptz`
   - `status` is always `Completed`
2. **`stocktransferline` is new:** the lines of one hospital request, with `qtyrequested` and
   `qtyissued`. One `transferid` = one basket for UC1.
3. **`consumption`** gets a unique index on (`warehouseid`, `productid`, `consumptiondate`); UC2's
   upsert needs it.
4. **`productrelationshipantecedent`** → `productrelationship` is `ON DELETE CASCADE`. UC1 deletes
   old rules and relies on this.
5. Extra indexes for speed.

CW → SW is unchanged: `orders` + `orderline`, where `orders.warehouseid` is the destination
subsidiary, `Processing` = in transit (`fulfilmentdate` NULL) and `Fulfilled` = delivered on
`fulfilmentdate`. The initial (pre-UC2) ROP / OUL / safety stock is stored in `warehouseproduct`.

`inventory` is the stock ledger: one row per movement, `qtyonhand` = balance after it.
Deliveries are at 08:00 and hand-outs at 19:00, at most two rows per product per day.

Also note: the live database has `inventorystatus = 'ACTIVE'`, which the repo's
`001_schema.sql` doesn't allow. The repo schema file is out of date with the live project.

---

## 7. Engine changes made today

**UC2** (`sql/uc2/uc2_setup.sql`, still `uc2-3.1`):

- If `uc2_policy_parameters` is in the old v1 shape (primary key includes `asofdate`, no
  `isdormant`), migrate now drops it and recreates the current shape. It only holds derived
  values, rebuilt by the next run. Newer tables are left alone.
- `replenishment --rebuild` empties `consumption` and rebuilds it from `inventory`. Use it after
  any inventory reload.

**UC1** (`engines/uc1/arm_jeremiahVer.py`, intended to replace `arm.py`):

- **Mines hospital requests** (`stocktransfer` + `stocktransferline`) instead of CW → SW orders.
- **Latest 90 days only** (`LOOKBACK_DAYS`), counted back from the newest request, not from today.
- **Connects via `DATABASE_URL`**; the old `SUPABASE_DB_*` variables still work as a fallback.
- **Thresholds tuned for 2,000 products and ~12-line baskets:** support ≥ 0.05%, confidence ≥ 5%,
  lift ≥ 2.0, pairs only.
- **A rule needs at least 20 requests containing both items** (`MIN_PAIR_COUNT`). Without it,
  rare items that meet a handful of times by chance produced hundreds of false rules.
- **Strength is graded on lift and confidence:** Strong = lift ≥ 10 and confidence ≥ 25%;
  Moderate = lift ≥ 3 and confidence ≥ 10%.
- **Sparse basket matrix,** so full scale fits in memory.
- **`run(destination_warehouse_id=…)` is now `run(source_warehouse_id=…)`.** `run_all.py` calls
  it without arguments, but it imports `engines.uc1.arm`, so rename the file (or the import)
  before using the orchestrator.
- **Scopes:** WH002–WH006 = each subsidiary's requests. **WH001 is only a label** for all
  subsidiaries' requests pooled together. It is **not** CW data. Open decision: keep it,
  drop it, or give it its own label.

---

## 8. What "working" looks like

**`check.py`** should print 8/8 PASS at full scale. The bundle check is information-only at dev.
It checks:

- every hand-out and delivery matches the ledger
- no negative stock or future-dated rows
- warehouse demand ratios 1.50 / 1.00 / 1.00 / 1.25 / 0.50
- each tier within ~1% of target
- lead times with mean 2.0
- busy items requested on 100% of days
- planted bundles 6–65× more often than chance, unrelated pairs about 1×

**UC2 on `full`:**

- Demand classes: about 6,400 smooth, 1,850 lumpy, 1,450 intermittent, 250 erratic.
- Forecasts within about 1% of the true rates (the Very Low tier comes out about 14% low).
- Low Stock by warehouse: WH002 ≫ WH005 > WH004 > WH003 ≫ WH006.

**UC1 on `full`:**

- 13–14 of 20 planted pairs found in every scope, with **0 false rules**. Strong bundles are
  labelled Strong.
- Bundles built on rare items are missed: the chemo bundle, and sometimes the tourniquet and
  heparin ones. They appear on fewer than 20 requests in 90 days. That's a known limitation of
  support-based mining for rare items.

---

## 9. Open items

- Agree the schema changes in section 6 before anything touches the live project.
- WH001 network scope in UC1: keep, drop, or relabel.
- Fill rates are about 99.5–100%. The naive ROP rarely causes stockouts; its inefficiency shows
  up as overstock at the slow warehouse. Lower `initial_policy.rop_days` for more stockouts.
- The central warehouse has unlimited supply (no supplier side).
- UC2's in-transit check (compare on hand + in transit against ROP) and the breach-check script
  aren't built yet. Orders in "Processing" are what they would read.