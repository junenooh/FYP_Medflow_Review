# Dashboard

Route: `#/`

Provides the UC1–UC4 overview and shared feedback-state gallery. KPI counts are read from persisted Supabase tables through `@shared/data/engine-outputs.js`.

`charts/kpi.js` is a reserved visualization hook. Import it from `index.js` only when a dashboard chart is implemented.
