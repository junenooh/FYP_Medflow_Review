# Notifications

The bell in the top bar. It reads UC2 output for every subsidiary and lists what needs attention. Frontend only: nothing is written to the database.

| File | Role |
| --- | --- |
| `rules.js` | UC2 output → alerts. Pure, no DOM or database |
| `store.js` | loads every subsidiary (shared cache with the UC2 page), reads hospital shortfalls, keeps read state in `localStorage` |
| `bell.js` | bell button and badge, panel, urgent toast |
| `notifications.css` | styles (level colours reuse the UC2 status tokens) |

## Alerts

| Level | Kind | Rule |
| --- | --- | --- |
| Urgent | Out of stock | on hand = 0 (dormant SKUs excluded) |
| Urgent | Runs out before delivery | days of cover < full days until the open order arrives (deliveries land at 08:00); with no open order but one due, < lead time |
| Urgent | Hospital shortfall | `qtyissued < qtyrequested` on a request line in the last 3 days |
| Warning | Unusual demand | UC2 `flag_possible_stockout`, `flag_demand_spiked` or `flag_demand_dropped` |
| Warning | Data behind | the inventory ledger has days after UC2's `asofdate` |
| Info | Reorder placed / Delivery received | orders placed or fulfilled on the as-of day |

- Written for an operations manager: each alert says what happened and who has to act (a chip: Needs action / Worth a check / Delivery on the way / Automatic). Technical detail is only in the hover text.
- The panel stays quiet: a one-line headline, then Urgent and Worth checking. Routine restock updates fold into one row (or the Updates tab).
- More than 3 alerts of one kind at one subsidiary fold into one group, which expands to its products.
- Product names stored in capitals are shown in title case ("HI-TAR SOLUTION 20%" → "Hi-Tar Solution 20%").
- The badge counts unread urgent and warning alerts. Updates never add to it.
- Ids include the as-of day, so a problem that is still there the next day comes back as unread.
- Clicking a product alert opens it on the UC2 page (`#/uc2?warehouse=WH002&tab=skus&sku=MED0170`).
- **Check again** rereads everything and repaints the UC2 page, for after `python -m scripts.live.day`.

## Setup

Hospital shortfall alerts need the dashboard key to read `stocktransferline`. Run `sql/policies/002_anon_read.sql` in the Supabase SQL Editor. Until then the panel says the alert is off.

## Limits

Read state is per browser. There is no email or push, and no history of past alerts: those need a backend table.
