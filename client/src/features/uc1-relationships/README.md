# UC1 — Product relationships

Route: `#/uc1`

Reads persisted `productrelationship` and `productrelationshipantecedent` rows. FP-Growth belongs in `engines/uc1/arm.py`; never calculate association rules in this feature.

The page and startup prefetch share per-page-load warehouse and relationship reads from `live-data.js`, keyed by warehouse selection.

`charts/network.js` is a reserved visualization hook. Import it from `index.js` when the relationship network is implemented.
