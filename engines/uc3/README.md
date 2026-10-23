# UC3 — central-warehouse slotting (`uc3-slotting-2.0`)

```bash
python -m engines.uc3.layout                 # one run per payback preset (7 / 30 / 60 / 90 days)
python -m engines.uc3.layout --preset 30     # one preset
python -m engines.uc3.layout --dry-run       # score and print, write nothing
```

Reads (read-only) WH001's bins, each product's current bins and stock (latest `inventory` row per
product × bin), measured demand (`uc2_policy_parameters.avgdailydemand` summed over the
subsidiaries, in cartons/day) and UC1's Strong / Moderate network rules. Writes `modelrun` and
`layoutrecommendation` only.

**Model.** A product's bins are its group; a group keeps its size and may only sit on consecutive
bins of one zone and one aisle. Layouts are scored in seconds per day: picking (cartons/day × mean
access time of the group), companions (picks together/day × walking time between related groups)
and moves (one-off labour per bin and per carton, divided by the payback period). The payback
preset is the planner's dial: 7 days = only moves that pay back within a week.

**Search.** Phase 1 heuristic from the current layout, highest demand first, moving a group only
if that pays back. Phase 2 simulated annealing (move / swap / send home) from the heuristic
layout, several seeds, best kept. Never saves a layout worse than today's.

**Output.** One `modelrun` per preset, tied by `batch=` in `parametersignature`; one
`layoutrecommendation` row per bin that moves (`currentbin` → `recommendedbin`), with the measured
velocity class, the reason (seconds saved, payback) and the UC1 lift. The UC3 page shows the
latest batch with a payback selector.

Settings: `shared_config.json` → `uc3` (distances, speed, trip factor, ladder penalty, handling
seconds per carton, payback presets, annealing).
