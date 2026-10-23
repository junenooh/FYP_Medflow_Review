-- WARNING: Context dump of the live FYP MedFlow DB schema. Do not run this file.
-- Table order and some constraint names in the exporter output are not valid DDL.
-- Project: ikjrcfqleskfgatsxdjr
-- Source of truth for engines/client: sql/schema-contract.md and engines/shared/db/tables.py

CREATE TABLE public.site (
  siteid character varying NOT NULL,
  sitename text NOT NULL,
  address text NOT NULL,
  warehouseid character varying NOT NULL,
  CONSTRAINT site_pkey PRIMARY KEY (siteid),
  CONSTRAINT site_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid)
);
CREATE TABLE public.warehouse (
  warehouseid character varying NOT NULL,
  warehousename text NOT NULL,
  address text NOT NULL,
  warehouserole text NOT NULL CHECK (warehouserole = ANY (ARRAY['CENTRAL'::text, 'SUBSIDIARY'::text])),
  CONSTRAINT warehouse_pkey PRIMARY KEY (warehouseid)
);
CREATE TABLE public.zone (
  zoneid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  zonename text NOT NULL,
  zonetype text NOT NULL,
  CONSTRAINT zone_pkey PRIMARY KEY (zoneid),
  CONSTRAINT zone_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid)
);
CREATE TABLE public.bin (
  binid character varying NOT NULL,
  zoneid character varying NOT NULL,
  capacityvolume bigint NOT NULL CHECK (capacityvolume > 0),
  status text NOT NULL,
  position_x double precision,
  position_y double precision,
  warehouseid character varying NOT NULL,
  CONSTRAINT bin_pkey PRIMARY KEY (binid),
  CONSTRAINT bin_zoneid_fkey FOREIGN KEY (zoneid) REFERENCES public.zone(zoneid),
  CONSTRAINT bin_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid)
);
CREATE TABLE public.product (
  productid character varying NOT NULL,
  productname text NOT NULL,
  category text NOT NULL,
  shelflife bigint NOT NULL,
  velocityclass text NOT NULL,
  productclassification text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['Available'::text, 'Phase-Out'::text, 'Discontinued'::text, 'Obsolete'::text, 'Inactive'::text, 'Archived'::text])),
  productgroup text DEFAULT 'General'::text,
  uom text DEFAULT 'Unit'::text,
  unitcostsgd real DEFAULT 0 CHECK (unitcostsgd >= 0::double precision),
  manualbasedemand real DEFAULT 0 CHECK (manualbasedemand >= 0::double precision),
  CONSTRAINT product_pkey PRIMARY KEY (productid)
);
CREATE TABLE public.storage (
  storageid character varying NOT NULL,
  productid character varying NOT NULL UNIQUE,
  lengthcm real NOT NULL CHECK (lengthcm > 0::double precision),
  widthcm real NOT NULL CHECK (widthcm > 0::double precision),
  heightcm real NOT NULL CHECK (heightcm > 0::double precision),
  weightkg real NOT NULL CHECK (weightkg > 0::double precision),
  unitsperbox bigint NOT NULL CHECK (unitsperbox > 0),
  boxespercarton bigint NOT NULL CHECK (boxespercarton > 0),
  CONSTRAINT storage_pkey PRIMARY KEY (storageid),
  CONSTRAINT storage_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid)
);
CREATE TABLE public.inventory (
  inventoryid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  binid character varying NOT NULL,
  qtyonhand bigint NOT NULL CHECK (qtyonhand >= 0),
  expirydate date NOT NULL,
  datereceived date NOT NULL,
  inventorystatus text NOT NULL CHECK (inventorystatus = ANY (ARRAY['Available'::text, 'Allocated'::text, 'Reserved'::text, 'Blocked'::text, 'Quarantine'::text, 'In Transit'::text, 'Expired'::text])),
  lastupdated timestamp with time zone NOT NULL,
  CONSTRAINT inventory_pkey PRIMARY KEY (inventoryid),
  CONSTRAINT inventory_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT inventory_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid),
  CONSTRAINT inventory_binid_fkey FOREIGN KEY (binid) REFERENCES public.bin(binid)
);
CREATE TABLE public.orders (
  orderid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  orderdate date NOT NULL,
  fulfilmentdate date,
  status text NOT NULL CHECK (status = ANY (ARRAY['Processing'::text, 'Fulfilled'::text, 'Cancelled'::text, 'On Hold'::text])),
  CONSTRAINT orders_pkey PRIMARY KEY (orderid),
  CONSTRAINT orders_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid)
);
CREATE TABLE public.orderline (
  orderlineid character varying NOT NULL,
  orderid character varying NOT NULL,
  productid character varying NOT NULL,
  qtyordered bigint NOT NULL CHECK (qtyordered >= 0),
  CONSTRAINT orderline_pkey PRIMARY KEY (orderlineid),
  CONSTRAINT orderline_orderid_fkey FOREIGN KEY (orderid) REFERENCES public.orders(orderid),
  CONSTRAINT orderline_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid)
);
CREATE TABLE public.stocktransfer (
  transferid character varying NOT NULL,
  orderid character varying NOT NULL UNIQUE,
  transferdate date,
  sourcewarehouseid character varying NOT NULL,
  destinationwarehouseid character varying NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['Requested'::text, 'In Transit'::text, 'Completed'::text, 'Cancelled'::text])),
  CONSTRAINT stocktransfer_pkey PRIMARY KEY (transferid),
  CONSTRAINT stocktransfer_orderid_fkey FOREIGN KEY (orderid) REFERENCES public.orders(orderid),
  CONSTRAINT stocktransfer_sourcewarehouseid_fkey FOREIGN KEY (sourcewarehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT stocktransfer_destinationwarehouseid_fkey FOREIGN KEY (destinationwarehouseid) REFERENCES public.warehouse(warehouseid)
);
CREATE TABLE public.consumption (
  consumptionid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  consumptiondate timestamp with time zone NOT NULL,
  closingqty bigint NOT NULL CHECK (closingqty >= 0),
  qtyconsumed bigint NOT NULL CHECK (qtyconsumed >= 0),
  CONSTRAINT consumption_pkey PRIMARY KEY (consumptionid),
  CONSTRAINT consumption_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT consumption_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid)
);
CREATE TABLE public.demand (
  demandid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  avgdailydemand real NOT NULL,
  calculateddate timestamp with time zone NOT NULL,
  runid character varying NOT NULL,
  demandhistorydays bigint NOT NULL,
  CONSTRAINT demand_pkey PRIMARY KEY (demandid),
  CONSTRAINT demand_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT demand_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid),
  CONSTRAINT demand_runid_fkey FOREIGN KEY (runid) REFERENCES public.modelrun(runid)
);
CREATE TABLE public.layoutrecommendation (
  movefieldid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  velocityclass text NOT NULL,
  movedirection text NOT NULL,
  reason text NOT NULL,
  distanceimprovementm real NOT NULL,
  timesavedseconds real CHECK (timesavedseconds >= 0::double precision),
  distanceimprovementpct real NOT NULL CHECK (distanceimprovementpct >= 0::double precision AND distanceimprovementpct <= 1::double precision),
  priority text NOT NULL CHECK (priority = ANY (ARRAY['Critical'::text, 'High'::text, 'Medium'::text, 'Low'::text, 'Deferred'::text])),
  avgdailydemand real NOT NULL,
  forconsolidation boolean NOT NULL,
  lift real,
  lastupdated date NOT NULL,
  currentbin character varying,
  recommendedbin character varying,
  runid character varying,
  CONSTRAINT layoutrecommendation_pkey PRIMARY KEY (movefieldid),
  CONSTRAINT layoutrecommendation_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT layoutrecommendation_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid),
  CONSTRAINT layoutrecommendation_runid_fkey FOREIGN KEY (runid) REFERENCES public.modelrun(runid),
  CONSTRAINT layoutrecommendation_currentbin_fkey FOREIGN KEY (currentbin) REFERENCES public.bin(binid),
  CONSTRAINT layoutrecommendation_recommendedbin_fkey FOREIGN KEY (recommendedbin) REFERENCES public.bin(binid)
);
CREATE TABLE public.warehouseproduct (
  warehouseproductid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  leadtimedays bigint CHECK (leadtimedays >= 0),
  servicelevel double precision CHECK (servicelevel >= 0::double precision AND servicelevel <= 1::double precision),
  safetystock bigint CHECK (safetystock > 0),
  reorderpoint bigint CHECK (reorderpoint >= 0),
  orderuptolevel double precision CHECK (orderuptolevel > 0::double precision),
  orderingcost numeric NOT NULL,
  holdingcost numeric NOT NULL,
  CONSTRAINT warehouseproduct_pkey PRIMARY KEY (warehouseproductid),
  CONSTRAINT warehouseproduct_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT warehouseproduct_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid)
);
CREATE TABLE public.modelrun (
  runid character varying NOT NULL,
  runtype text NOT NULL,
  generatedate timestamp with time zone NOT NULL,
  algorithmversion text,
  parametersignature text,
  CONSTRAINT modelrun_pkey PRIMARY KEY (runid)
);
CREATE TABLE public.warehouseproductcalculation (
  calculationid character varying NOT NULL,
  runid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  leadtimedays bigint NOT NULL CHECK (leadtimedays >= 0),
  servicelevel real NOT NULL CHECK (servicelevel >= 0::double precision AND servicelevel <= 1::double precision),
  safetystock bigint NOT NULL CHECK (safetystock > 0),
  reorderpoint bigint NOT NULL CHECK (reorderpoint >= 0),
  orderuptolevel bigint NOT NULL CHECK (orderuptolevel > 0),
  stddemandleadtime real NOT NULL,
  eoq real NOT NULL DEFAULT 0 CHECK (eoq >= 0::double precision),
  CONSTRAINT warehouseproductcalculation_pkey PRIMARY KEY (calculationid),
  CONSTRAINT warehouseproductcalculation_runid_fkey FOREIGN KEY (runid) REFERENCES public.modelrun(runid),
  CONSTRAINT warehouseproductcalculation_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT warehouseproductcalculation_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid)
);
CREATE TABLE public.productrelationship (
  relationshipid character varying NOT NULL,
  warehouseid character varying NOT NULL,
  consequent_productid character varying NOT NULL,
  itemsetsize bigint NOT NULL CHECK (itemsetsize >= 2),
  support real NOT NULL CHECK (support >= 0::double precision AND support <= 1::double precision),
  confidence real NOT NULL CHECK (confidence >= 0::double precision AND confidence <= 1::double precision),
  lift real NOT NULL CHECK (lift >= 0::double precision),
  strength text NOT NULL,
  ordercount bigint NOT NULL CHECK (ordercount >= 0),
  rulesource text NOT NULL,
  lastupdated date NOT NULL,
  runid character varying,
  CONSTRAINT productrelationship_pkey PRIMARY KEY (relationshipid),
  CONSTRAINT productrelationship_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT productrelationship_consequent_productid_fkey FOREIGN KEY (consequent_productid) REFERENCES public.product(productid),
  CONSTRAINT productrelationship_runid_fkey FOREIGN KEY (runid) REFERENCES public.modelrun(runid)
);
CREATE TABLE public.productrelationshipantecedent (
  relationshipid character varying NOT NULL,
  antecedent_productid character varying NOT NULL,
  CONSTRAINT productrelationshipantecedent_pkey PRIMARY KEY (relationshipid, antecedent_productid),
  CONSTRAINT productrelationshipantecedent_relationshipid_fkey FOREIGN KEY (relationshipid) REFERENCES public.productrelationship(relationshipid),
  CONSTRAINT productrelationshipantecedent_productid_fkey FOREIGN KEY (antecedent_productid) REFERENCES public.product(productid)
);
CREATE TABLE public.replenishmentrecommendation (
  recommendationid character varying NOT NULL,
  relationshipid character varying,
  runid character varying NOT NULL,
  generatedat timestamp with time zone NOT NULL,
  warehouseid character varying NOT NULL,
  productid character varying NOT NULL,
  qtyonhand bigint NOT NULL CHECK (qtyonhand >= 0),
  reorderpoint bigint NOT NULL CHECK (reorderpoint >= 0),
  safetystock bigint NOT NULL CHECK (safetystock > 0),
  orderuptolevel bigint NOT NULL CHECK (orderuptolevel > 0),
  recommendedorderqty bigint NOT NULL CHECK (recommendedorderqty > 0),
  leadtimedays bigint NOT NULL CHECK (leadtimedays >= 0),
  avgdailydemand real NOT NULL CHECK (avgdailydemand >= 0::double precision),
  daysofsupply real NOT NULL CHECK (daysofsupply >= 0::double precision),
  inventorystatus text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['Low Stock'::text, 'Near ROP'::text, 'Available'::text])),
  recommendationstatus text NOT NULL CHECK (recommendationstatus = ANY (ARRAY['Pending'::text, 'Accepted'::text, 'Modified'::text, 'Declined'::text, 'Dismissed'::text])),
  fulfillmentstatus text NOT NULL CHECK (fulfillmentstatus = ANY (ARRAY['Unfulfilled'::text, 'Fulfilled'::text, 'Cannot Fulfill'::text])),
  replenishmenttype text NOT NULL,
  unitcostsgd numeric NOT NULL CHECK (unitcostsgd::double precision >= 0::double precision),
  estimatedordervalue numeric NOT NULL CHECK (estimatedordervalue::double precision >= 0::double precision),
  riskscore bigint NOT NULL CHECK (riskscore >= 0),
  projectedstockoutriskpct real NOT NULL CHECK (projectedstockoutriskpct >= 0::double precision AND projectedstockoutriskpct <= 100::double precision),
  demandsource text NOT NULL,
  demandhistorydays bigint NOT NULL CHECK (demandhistorydays >= 0),
  copickskus text NOT NULL,
  copicknames text NOT NULL,
  copicklift real NOT NULL CHECK (copicklift >= 0::double precision),
  clustersavingssgd numeric NOT NULL CHECK (clustersavingssgd::double precision >= 0::double precision),
  recommendationreason text NOT NULL,
  CONSTRAINT replenishmentrecommendation_pkey PRIMARY KEY (recommendationid),
  CONSTRAINT replenishmentrecommendation_relationshipid_fkey FOREIGN KEY (relationshipid) REFERENCES public.productrelationship(relationshipid),
  CONSTRAINT replenishmentrecommendation_runid_fkey FOREIGN KEY (runid) REFERENCES public.modelrun(runid),
  CONSTRAINT replenishmentrecommendation_warehouseid_fkey FOREIGN KEY (warehouseid) REFERENCES public.warehouse(warehouseid),
  CONSTRAINT replenishmentrecommendation_productid_fkey FOREIGN KEY (productid) REFERENCES public.product(productid)
);

create table public.uc3_run (
  runid character varying NOT NULL,
  batchid character varying NOT NULL,
  payback_days integer NOT NULL,
  current_pick_s real NOT NULL,
  current_companion_s real NOT NULL,
  heuristic_pick_s real NOT NULL,
  heuristic_companion_s real NOT NULL,
  heuristic_move_s real NOT NULL,
  sa_pick_s real NOT NULL,
  sa_companion_s real NOT NULL,
  sa_move_s real NOT NULL,
  saved_s_per_day real NOT NULL,
  heuristic_to_sa_s real NOT NULL,
  actual_payback_days real NULL,
  current_avg_access_s real NULL,
  sa_avg_access_s real NULL,
  products_total integer NOT NULL,
  products_moved integer NOT NULL,
  bins_total integer NOT NULL,
  bins_moved integer NOT NULL,
  sa_seeds_tested jsonb NULL,
  sa_seed_scores jsonb NULL,
  sa_seed_best integer NULL,
  sa_seed_score_best real NULL,
  sa_intensify_seed integer NULL,
  sa_intensify_gain_s real NULL,
  sa_iterations integer NULL,
  sa_start_temperature real NULL,
  sa_cooling_rate real NULL,
  sa_min_temperature real NULL,
  sa_calibrated boolean NOT NULL default true,
  upstream_uc1_runid character varying NULL,
  uc1_rule_count integer NULL,
  uc2_asofdate date NULL,
  uc2_rows_used integer NULL,
  generatedate timestamp with time zone NOT NULL default now(),
  CONSTRAINT uc3_run_pkey PRIMARY KEY (runid),
  CONSTRAINT uc3_run_runid_fkey FOREIGN KEY (runid) REFERENCES modelrun (runid) on update CASCADE on delete CASCADE,
  CONSTRAINT uc3_run_payback_check CHECK ((payback_days > 0)),
  CONSTRAINT uc3_run_products_check CHECK (
    (
      (products_moved >= 0)
      and (products_moved <= products_total)
    )
  ),
  CONSTRAINT uc3_run_sa_never_worse CHECK (
    (
      ((sa_pick_s + sa_companion_s) + sa_move_s) <= (
        (current_pick_s + current_companion_s) + (0.0001)::double precision
      )
    )
  ),
  CONSTRAINT uc3_run_bins_check CHECK (
    (
      (bins_moved >= 0)
      and (bins_moved <= bins_total)
    )
  ),
  CONSTRAINT uc3_run_saving_non_negative CHECK (
    (
      saved_s_per_day >= ('-0.0001'::numeric)::double precision
    )
  ),
  CONSTRAINT uc3_run_heuristic_never_worse CHECK (
    (
      (
        (heuristic_pick_s + heuristic_companion_s) + heuristic_move_s
      ) <= (
        (current_pick_s + current_companion_s) + (0.0001)::double precision
      )
    )
  )
);