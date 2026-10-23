# FYP_Medflow

MedFlow is a shared decision-support dashboard for medical warehouse operations.

## Design and brand guides

- [MedFlow brand guide](docs/design/medflow-brand-guide.html) — product identity, co-branding, colour, typography and voice.
- [MedFlow design guide](docs/design/medflow-design-guide.html) — shared shell, navigation, components, charts and page patterns.

| Use case | Name | What it does |
| --- | --- | --- |
| **UC1** | Association Rule Mining | Find SKUs frequently ordered together |
| **UC2** | Replenishment Policy | Recommend transfers from central → subsidiaries |
| **UC3** | Slotting Optimisation | Suggest bin placements that cut picker travel |
| **UC4** | Interactive Digital Twin | 3D twin of the warehouse layout |

This repo is the **one team project**. Everyone opens the same app, uses the same Supabase project, and installs the same dependencies. Do not create a second Vite app or personal HTML demo.

## Shared interface

Everyone runs this repo and opens:

**http://127.0.0.1:5173/**

| Route | Page |
| --- | --- |
| `#/` | Overview (UC1–UC4 cards) |
| `#/uc1` | Association Rule Mining |
| `#/uc2` | Replenishment Policy |
| `#/uc3` | Slotting Optimisation |
| `#/uc4` | Interactive Digital Twin |
| `#/test` | Supabase connection smoke check |

**How modules connect**

```
engines/ (Python)  --service_role write-->  Supabase
client/  (Vite UI) --anon key read------>  Supabase
UC3 Layout (grid now; Three.js later) mounts inside #/uc3 (same app, not a separate site)
```

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 20+ (`node -v`) |
| Python | 3.12 (`python3 --version`) |
| npm | comes with Node |

**Ubuntu/Debian:** if `python3 -m venv` fails:

```bash
sudo apt install python3.12-venv
```

## One-time setup (every teammate)

```bash
git clone https://github.com/junenooh/FYP_Medflow.git
cd FYP_Medflow
git checkout main
git pull origin main
```

### 1. Shared secrets (not in Git)

Create `.env.local` at the **repo root** (gitignored). Use the same FYP MedFlow DB keys for everyone:

```
VITE_SUPABASE_URL=https://ikjrcfqleskfgatsxdjr.supabase.co
VITE_SUPABASE_ANON_KEY=...
SUPABASE_URL=https://ikjrcfqleskfgatsxdjr.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Keys: [Supabase API settings](https://supabase.com/dashboard/project/ikjrcfqleskfgatsxdjr/settings/api)  
Never commit `.env.local`.

### 2. Same Node packages

```bash
npm ci
```

Use `npm ci` for a clean first install so it matches `package-lock.json`. Only run `npm install` by hand when adding a package, then commit both `package.json` and `package-lock.json`.

You do not need to remember this after a `git pull`: `python start_all.py` runs `npm install` automatically when `node_modules` is missing or `package.json` / `package-lock.json` is newer than the last install. Start the app through `start_all.py`, not `npm run dev` directly, or this check is skipped.

### 3. Same Python packages

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
```

Activate `.venv` in every new terminal before running engines.

If Ubuntu creates `.venv` without `pip`, repair it with:

```bash
sudo apt update
sudo apt install -y python3.12-venv
python3 -m venv --upgrade .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### 4. Check the database, then start

```bash
source .venv/bin/activate
python start_all.py --check        # compare anon and service_role table access
python start_all.py                # check again, install Node deps if stale, then start Vite on port 5173
```

Open http://127.0.0.1:5173/ — you should see Overview with UC1–UC4.

Open http://127.0.0.1:5173/#/test, or choose **System → Connection test** in the sidebar. Click **Run test** to check:

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` were loaded by Vite.
- the anon key can read products;
- the `WH001` central warehouse is visible;
- Supabase errors are shown in the diagnostic panel.

The browser page is a quick smoke test. `python start_all.py --check` is the authoritative check because it compares **all tables** with both the anon and service-role keys.

If `anon` is 0 while `service` has rows, paste [`sql/policies/002_anon_read.sql`](sql/policies/002_anon_read.sql) in the [SQL editor](https://supabase.com/dashboard/project/ikjrcfqleskfgatsxdjr/sql/new), then run `--check` again.

Do not treat `product rows: 12` by itself as complete access. For example, if the browser reports `warehouse rows: 0`, connectivity works but row-level security is still hiding warehouse data. A fully healthy CLI check ends with:

```text
Anon read looks OK.
```

### Supabase troubleshooting

| Result | Meaning | Fix |
| --- | --- | --- |
| `Missing VITE_SUPABASE_URL` | `.env.local` is missing or was not loaded | Add the value at repo root and restart Vite |
| `Missing VITE_SUPABASE_ANON_KEY` | Browser read key is missing | Copy the anon key from Supabase API settings |
| `Missing SUPABASE_SERVICE_ROLE_KEY` | Engine/check key is missing | Add the service-role key to `.env.local`; never expose it to Vite |
| anon `0`, service `> 0` | Connection works, but RLS hides rows | Apply `sql/policies/002_anon_read.sql` |
| both keys return an HTTP error | URL/key mismatch or Supabase request failed | Confirm all keys belong to project `ikjrcfqleskfgatsxdjr` |
| port 5173 is already in use | Another Vite process is running | Reuse that server or stop it before starting another |
| `Failed to resolve import "<package>"` (e.g. `tabulator-tables`) | A pulled change added a Node dependency that is not installed | Stop Vite, run `npm install`, then start with `python start_all.py` (it does this automatically; `npm run dev` alone does not) |

## Daily commands

```bash
git pull origin main
source .venv/bin/activate
python3 start_all.py                      # shared dashboard (auto-installs new Node deps)
python3 -m engines.run_all                # UC1 → UC2 → UC3
python3 scripts/setup_supabase.py         # table counts only
```

## Engine runs (UC1 → UC2 → UC3)

Ops/Analysts run the batch pipeline with one command:

```bash
python3 -m engines.run_all
```

**Order:** UC1 (affinity) → UC2 (replenishment) → UC3 (layout).  
**Fail-stop:** if an upstream stage fails, dependents do not start.  
**UC4** is not batched — after a successful UC3 run, open the planner UI and load that UC3 `runid`.

### Where results and errors go

| Outcome | Where it is stored | Notes |
| --- | --- | --- |
| **Success** | Supabase `modelrun` (+ UC output tables) | Planner-facing lineage: runid, times, params, row counts |
| **Failure / debug** | Local daily log | Not written to Supabase |

Daily log files:

```text
logs/engine_runs_2026-09-05.log
logs/engine_runs_2026-09-06.log
…
```

- One file per UTC day  
- New failures **append** to today’s file  
- Files **older than 14 days** are deleted automatically on the next run  
- `logs/` is gitignored (local only; do not commit)

View today’s log:

```bash
cat logs/engine_runs_$(date -u +%F).log
```

`modelrun` keeps the existing columns only (`runid`, `runtype`, `generatedate`, `algorithmversion`, `parametersignature`). Row counts / upstream runid are folded into `parametersignature` on success — no schema change.

## Team rules

1. **One repo, one `main`, one URL.** All demos go through http://127.0.0.1:5173/.
2. **No separate frontends.** UC work lands in `client/src/features/` and `engines/uc*/`.
3. **One Supabase project** — FYP MedFlow DB (`ikjrcfqleskfgatsxdjr`).
4. **Same install path** — `npm ci` + `.venv` + `.env.local`. Start via `python start_all.py` so new dependencies are installed after a pull. Commit `package-lock.json` with every `package.json` change.
5. **Engines write Supabase; UI reads Supabase.** Do not import a teammate’s Python into the browser.
6. **Success → Supabase; failure → local daily log.** Do not dump debug failures into planner tables.
7. **UC3 Layout** lives at `#/uc3` (grid + reserved 3D mount). Do not ship a second localhost Three.js app. UC4 is the planner-decision frame.
8. Fill existing stubs. Do not invent `productlocation` or `WH-CENTRAL` tables. Central = **WH001**, subsidiary = **WH002**.

## Ownership map

| Area | Path |
| --- | --- |
| App shell / routing | `client/src/app/` |
| Shared UI / data | `client/src/shared/` |
| Dashboard | `client/src/features/dashboard/` |
| UC1 | `engines/uc1/`, `client/src/features/uc1-relationships/` |
| UC2 | `engines/uc2/`, `client/src/features/uc2-replenishment/` |
| UC3 | `engines/uc3/`, `client/src/features/uc3-layout/` |
| UC4 | `client/src/features/uc4-digital-twin/` |
| Supabase test | `client/src/features/connection-test/` |

## File structure

```
start_all.py                          # boot: .env.local, ping Supabase, npm install if stale, start Vite
shared_config.json                    # ARM / ROP thresholds (not secrets)
requirements.txt                      # Python deps
package.json / package-lock.json      # Node deps — install with npm ci
vite.config.js                        # Vite root = client/, envDir = repo root
pyproject.toml                        # ruff
.gitignore                            # .env.local, node_modules, .venv, dist, logs/
logs/                                 # local only: engine_runs_YYYY-MM-DD.log (14-day retention)

client/                               # shared planner UI (anon key)
  index.html
  assets/brand/                       # logos and co-brand assets
  src/
    app/                              # bootstrap, shell, router, navigation
    features/
      dashboard/
      uc1-relationships/
      uc2-replenishment/
      uc3-layout/                     # grid + reserved Three.js mount
      uc4-digital-twin/
      connection-test/
    shared/
      components/                     # reusable page frames, tables, cards
      data/                           # Supabase client and persisted outputs
      utils/                          # shared state helpers
      styles/                         # tokens, layout and component CSS

engines/                              # Python batch jobs (service_role)
  run_all.py                          # UC1 → UC2 → UC3 (fail-stop)
  run_log.py                          # daily local failure logs
  result.py                           # shared stage result contract
  uc1/arm.py
  uc2/replenishment.py
  uc3/layout.py
  shared/db/                          # config, schema constants, service client

sql/
  schema/001_schema.sql               # schema dump; do not run
  policies/002_anon_read.sql          # paste for dashboard SELECT
  schema-contract.md                  # live names, enums and constraints

scripts/
  setup_supabase.py

docs/
  architecture/system-workflow.md
  data/data-documentation.md
  use-cases/technical-documentation.md
  images/
```

## Docs

- Algorithms: [`docs/use-cases/technical-documentation.md`](docs/use-cases/technical-documentation.md)
- ERD / data model: [`docs/data/data-documentation.md`](docs/data/data-documentation.md)
- System architecture: [`docs/architecture/system-workflow.md`](docs/architecture/system-workflow.md)

## Final presentation (later)

For day-to-day work, use local install (`npm ci` + venv). Closer to the final demo, we can add a Docker image so one laptop serves the built UI. That is optional for now.
