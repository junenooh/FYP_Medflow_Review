# Installing the rebuild (14 Oct 2026)

Unzip at the repo root (it overwrites the files it contains). Then, in order:

```bash
python -m engines.uc2.migrate                                   # UC2 objects -> uc2-3.3
python -m scripts.sim.generate --profile full                   # reads the masters from the cloud
```

If the client has not yet raised `bin.maxweightkg` to 60 kg, `generate` reports that Central does
not fit. Plan with `--bin-max-weight-kg 60`; the loader will refuse until the table is changed.

```bash
python -m scripts.sim.load --profile full                       # dry run: every check, writes nothing
python -m scripts.sim.load --profile full --apply --confirm-host <host from the dry run>   # ~5-10 min
python -m scripts.sim.check --profile full                      # 9 checks, incl. the bundle bands
python -m engines.uc2.service_levels --csv reports/service_levels.csv   # the table for clinical review
python -m engines.uc2.service_levels --apply                    # writes the per-product z overrides
python -m engines.uc2.replenishment --rebuild --direct          # consumption + policy, minutes
python -m scripts.live.day --dry-run                            # rehearse one live day
```

The UC2 page needs no changes beyond `live-data.js` (carton rounding now matches the reorder rule).
UC1 (`arm_jeremiahVer.py`) is unchanged: align its thresholds to the bands in
`scripts/sim/sim_config.json` (`bundles.bands`) when you adjust it, then run
`python -m scripts.sim.score_uc1 --profile full`.
