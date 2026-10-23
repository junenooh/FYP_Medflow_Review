# UC3 — Slotting intelligence

Route: `#/uc3`

Reads `layoutrecommendation`, bin, zone and inventory data and presents three synchronized planner views:

- a D3/SVG 2.5D current and recommended slotting map;
- a searchable and sortable Tabulator assignment table; and
- a demand-weighted access-time comparison using the same scoring parameters for every scenario.

When a completed UC3 run is unavailable, the page uses the clearly labelled WH001 analytical sample in `reference-floor.js`. Slotting, constraint validation and simulated annealing still belong in `engines/uc3/layout.py`; the browser only analyses and presents persisted output.
