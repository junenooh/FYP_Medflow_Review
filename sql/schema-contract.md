# Live FYP MedFlow DB schema contract (`ikjrcfqleskfgatsxdjr`)

Dumper output (do not run): [`schema/001_schema.sql`](schema/001_schema.sql). Code against this live FYP MedFlow DB schema.

- Central warehouse: **WH001** (`warehouserole = CENTRAL`). Subsidiary: **WH002**.
- On-hand quantity: **`inventory.qtyonhand`** (slot = `inventory.binid` → `bin`). There is **no** `productlocation` table.
- Column names are concatenated lowercase: `warehouseid`, `productid`, `qtyonhand`.
- Exceptions with an underscore: `position_x`, `position_y`, `consequent_productid`, `antecedent_productid`.
- Python/JS identifiers: `engines/shared/db/tables.py` and `client/src/shared/data/tables.js`.

Paste `policies/002_anon_read.sql` so the dashboard (anon key) can SELECT. Engines use **service_role**.
`uc3_run` carries its own RLS + select policy inside `uc3_run.sql`; it is not in `002_anon_read.sql`.

## Engine write order

1. `modelrun` (`runid`)
2. UC1: `productrelationship` then `productrelationshipantecedent`
3. UC2: `replenishmentrecommendation` (optional `relationshipid`; required `runid`)
4. UC3: `layoutrecommendation` (`currentbin` / `recommendedbin` must be real `bin.binid`s), then `uc3_run`

One `modelrun` + one `uc3_run` + N `layoutrecommendation` rows **per payback preset**, each preset in its own
transaction. `uc3_run.runid` = `layoutrecommendation.runid` = `modelrun.runid`; `uc3_run.batchid` is shared by
every preset of one invocation. `uc3_run` is written last so its CHECKs gate the commit.

Delete in reverse. If a replenishment row points at a relationship, delete the replenishment row first.
Deleting a `modelrun` cascades to `uc3_run` but is **blocked** by `layoutrecommendation` (no `ON DELETE`
rule) — delete the recommendation rows first, then the `modelrun`.

## CHECK enums (use these strings exactly)

| Column | Allowed values |
| --- | --- |
| `warehouse.warehouserole` | `CENTRAL`, `SUBSIDIARY` |
| `product.status` | `Available`, `Phase-Out`, `Discontinued`, `Obsolete`, `Inactive`, `Archived` |
| `inventory.inventorystatus` | `Available`, `Allocated`, `Reserved`, `Blocked`, `Quarantine`, `In Transit`, `Expired` |
| `orders.status` | `Processing`, `Fulfilled`, `Cancelled`, `On Hold` |
| `stocktransfer.status` | `Requested`, `In Transit`, `Completed`, `Cancelled` |
| `layoutrecommendation.priority` | `Critical`, `High`, `Medium`, `Low`, `Deferred` |
| `replenishmentrecommendation.status` | `Out of Stock`, `Low Stock`, `Near ROP`, `Available` |
| `replenishmentrecommendation.recommendationstatus` | `Pending`, `Accepted`, `Modified`, `Declined`, `Dismissed` |
| `replenishmentrecommendation.fulfillmentstatus` | `Unfulfilled`, `Fulfilled`, `Cannot Fulfill` |

`inventory.inventorystatus` is not the same column as `replenishmentrecommendation.inventorystatus` (the latter has no CHECK). Do not write `Below ROP` into `inventory`.

No CHECK (free text / numbers): `zone.zonetype`, `bin.status`, `product.velocityclass`, `productrelationship.rulesource`, `replenishmentrecommendation.replenishmenttype`. Live sample zonetypes are `FAST`/`MEDIUM`/`SLOW`/`BULK`/`PICK` (`Z001`–`Z010`, not `FAST` as a zone id).

## Numeric CHECKs that will reject engine writes

| Column | Rule |
| --- | --- |
| `layoutrecommendation.distanceimprovementpct` | **0–1** (fraction, not 0–100) |
| `replenishmentrecommendation.projectedstockoutriskpct` | **0–100** |
| `productrelationship.support`, `confidence` | 0–1 |
| `warehouseproduct.servicelevel` (and calculation) | 0–1 |
| `safetystock` on replenishment / warehouseproduct / calculation | **> 0** (zero fails) |
| `recommendedorderqty`, `orderuptolevel` | **> 0** |
| `productrelationship.itemsetsize` | **≥ 2** |
| `storage` length/width/height/weight and box counts | **> 0** |
| `uc3_run.payback_days` | **> 0** |
| `uc3_run.products_moved` | 0 … `products_total` |
| `uc3_run.bins_moved` | 0 … `bins_total` |
| `uc3_run.saved_s_per_day` | **≥ −1e-4** (whole-run saving may not be negative) |
| `uc3_run` SA totals | `sa_pick_s + sa_companion_s + sa_move_s` ≤ `current_pick_s + current_companion_s` + 1e-4 |
| `uc3_run` heuristic totals | same rule for the three `heuristic_*_s` columns |

## Tables and columns

PK / NOT NULL columns are marked `*`. Nullable / optional: no star.

### warehouse
`warehouseid*` `warehousename*` `address*` `warehouserole*`

### site
`siteid*` `sitename*` `address*` `warehouseid*` → warehouse

### zone
`zoneid*` `warehouseid*` `zonename*` `zonetype*`

### bin
`binid*` `zoneid*` `capacityvolume*` (> 0) `status*` `warehouseid*` `position_x` `position_y`

### product
`productid*` `productname*` `category*` `shelflife*` `velocityclass*` `productclassification*` `status*` `productgroup` `uom` `unitcostsgd` `manualbasedemand`

### storage
`storageid*` `productid*` (unique) `lengthcm*` `widthcm*` `heightcm*` `weightkg*` `unitsperbox*` `boxespercarton*`

### inventory
`inventoryid*` `warehouseid*` `productid*` `binid*` `qtyonhand*` `expirydate*` `datereceived*` `inventorystatus*` `lastupdated*`

### orders
`orderid*` `warehouseid*` `orderdate*` `status*` `fulfilmentdate`

### orderline
`orderlineid*` `orderid*` `productid*` `qtyordered*`

### stocktransfer
`transferid*` `orderid*` (unique) `sourcewarehouseid*` `destinationwarehouseid*` `status*` `transferdate`

### consumption
`consumptionid*` `warehouseid*` `productid*` `consumptiondate*` `closingqty*` `qtyconsumed*`

### demand
`demandid*` `warehouseid*` `productid*` `avgdailydemand*` `calculateddate*` `runid*` → modelrun `demandhistorydays*`

### warehouseproduct
`warehouseproductid*` `warehouseid*` `productid*` `orderingcost*` `holdingcost*` `leadtimedays` `servicelevel` `safetystock` `reorderpoint` `orderuptolevel`

### warehouseproductcalculation
`calculationid*` `runid*` `warehouseid*` `productid*` `leadtimedays*` `servicelevel*` `safetystock*` `reorderpoint*` `orderuptolevel*` `stddemandleadtime*` `eoq*`

### modelrun
`runid*` `runtype*` `generatedate*` `algorithmversion` `parametersignature`

### productrelationship (UC1)
`relationshipid*` `warehouseid*` `consequent_productid*` `itemsetsize*` `support*` `confidence*` `lift*` `strength*` `ordercount*` `rulesource*` `lastupdated*` `runid`

### productrelationshipantecedent (UC1)
composite PK: `relationshipid*` `antecedent_productid*`

### replenishmentrecommendation (UC2)
`recommendationid*` `runid*` `generatedat*` `warehouseid*` `productid*` `qtyonhand*` `reorderpoint*` `safetystock*` `orderuptolevel*` `recommendedorderqty*` `leadtimedays*` `avgdailydemand*` `daysofsupply*` `inventorystatus*` `status*` `recommendationstatus*` `fulfillmentstatus*` `replenishmenttype*` `unitcostsgd*` `estimatedordervalue*` `riskscore*` `projectedstockoutriskpct*` `demandsource*` `demandhistorydays*` `copickskus*` `copicknames*` `copicklift*` `clustersavingssgd*` `recommendationreason*` `relationshipid`

### layoutrecommendation (UC3)
`movefieldid*` `warehouseid*` `productid*` `velocityclass*` `movedirection*` `reason*` `distanceimprovementm*` `distanceimprovementpct*` `priority*` `avgdailydemand*` `forconsolidation*` `lastupdated*` `lift` `timesavedseconds` `currentbin` `recommendedbin` `runid`

### uc3_run (UC3 audit)
`runid*` (PK) → modelrun (`ON UPDATE CASCADE ON DELETE CASCADE`) `batchid*` `payback_days*`
`current_pick_s*` `current_companion_s*`
`heuristic_pick_s*` `heuristic_companion_s*` `heuristic_move_s*`
`sa_pick_s*` `sa_companion_s*` `sa_move_s*`
`saved_s_per_day*` `heuristic_to_sa_s*` `actual_payback_days`
`current_avg_access_s` `sa_avg_access_s`
`products_total*` `products_moved*` `bins_total*` `bins_moved*`
`sa_seeds_tested` `sa_seed_scores` `sa_seed_best` `sa_seed_score_best`
`sa_intensify_seed` `sa_intensify_gain_s` `sa_iterations` `sa_start_temperature`
`sa_cooling_rate` `sa_min_temperature` `sa_calibrated*`
`upstream_uc1_runid` `uc1_rule_count` `uc2_asofdate` `uc2_rows_used`
`generatedate*` (default `now()`)

## Sample masters (already in the project)

| Kind | Ids |
| --- | --- |
| Products | MED001–MED012 |
| Bins | BIN001… (22 rows) |
| Orders | 16 orders / 47 order lines |
| Inventory | 24 rows on WH001 and WH002 |
