# Frontend source map

- `app/` — Vite entry, hash router, shared shell and navigation.
- `features/` — one folder per user-facing capability. Keep feature-only pages, charts and visualizations here.
- `shared/components/` — reusable UI used by two or more features.
- `shared/data/` — Supabase client, schema names, row mappers and persisted engine-output readers.
- `shared/utils/` — framework-independent helpers.
- `shared/styles/` — design tokens, shell layout and component styles.

Features may import from `@app`, `@shared` and their own folder. Shared modules must not import from a feature.

Keep browser configuration in Vite environment variables. The root `shared_config.json` belongs to the Python engines and should only be exposed to the frontend when a real UI requirement needs it.
