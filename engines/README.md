# Engine source map

- `uc1/` — association-rule mining and `productrelationship` output.
- `uc2/` — replenishment policy and `replenishmentrecommendation` output.
- `uc3/` — slotting optimization and `layoutrecommendation` output.
- `shared/db/` — schema constants, shared configuration and service-role Supabase access.
- `run_all.py` — UC1 → UC2 → UC3 orchestration.

Run modules from the repository root, for example `python -m engines.uc1.arm`.
