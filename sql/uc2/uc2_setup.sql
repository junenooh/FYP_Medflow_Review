-- ============================================================================
-- uc2_setup.sql -- MedFlow UC2: consumption and replenishment policy
--
-- VERSION: uc2-3.3   (must match engines/uc2/version.py)
--
-- This file is the single source of truth for everything UC2 installs in the
-- database. Edit this file, then paste the whole of it into the Supabase SQL
-- Editor (or run python -m engines.uc2.migrate once that can connect).
--
-- Re-running is safe AND non-destructive: functions are dropped and
-- recreated, tables are only ever extended in place. Nothing in this file
-- deletes stored data.
--
-- WHAT IT TOUCHES
--   reads   public.inventory, public.consumption, public.warehouse,
--           public.product
--   writes  public.consumption             (its six existing columns only)
--           public.uc2_settings            (UC2's own)
--           public.uc2_settings_history    (UC2's own)
--           public.uc2_policy_parameters   (UC2's own)
--   never   alters a table UC2 does not own, and never writes to
--           warehouseproductcalculation, demand, modelrun or
--           replenishmentrecommendation
--
-- THE PIPELINE
--   1. inventory   -> consumption     daily usage recovered from the ledger
--   2. consumption -> demand class    ADI / CV2 over the classification window
--   3. demand class -> mu, sigma      SES for smooth items, SBA for the rest
--   4. mu, sigma   -> SS, ROP, OUL    stored for the reorder check
--
-- CHANGES IN 3.0
--   * The 30/60/90 lookback tiers are gone. Each SKU is classified by how its
--     demand behaves (Syntetos, Boylan & Croston 2005) and forecast with the
--     method that suits it: exponential smoothing (Brown 1959) for smooth
--     demand, the Syntetos-Boylan approximation to Croston's method for
--     erratic, intermittent and lumpy demand.
--   * Safety stock includes lead-time variability (sigma_LT).
--   * Lead-time overrides per warehouse and/or SKU, with an expiry date and a
--     reason, every change recorded in uc2_settings_history.
--   * uc2_preview_parameters: read-only what-if for the dashboard. It uses the
--     same calculation as the stored policy, so preview and reality agree.
--   * Flags for the dashboard, thresholds kept in uc2_settings.
--   * Fixes: DELETE statements carry a WHERE clause (Supabase refuses a bare
--     DELETE through the API); uc2_ledger_maxday has its own time limit.
--
-- CHANGES IN 3.1
--   * uc2_reset_consumption: empties consumption so it can be rebuilt from
--     scratch after inventory has been regenerated (engine: --rebuild).
-- ============================================================================


-- ============================================================================
-- PART 0 -- remove every previous UC2 function, whatever its signature
--
-- CREATE OR REPLACE only replaces a function whose argument list is identical.
-- Change the arguments and Postgres keeps both, and the next call fails with
-- "function is not unique". Dropping by name first makes that impossible.
-- CASCADE also drops the audit trigger; PART 11 recreates it.
-- ============================================================================

DO $drop$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'uc2_schema_version',
              'uc2_seed_settings',
              'uc2_ledger_maxday',
              'uc2_build_consumption',
              'uc2_append_consumption',
              'uc2_calc',
              'uc2_compute_parameters',
              'uc2_preview_parameters',
              'uc2_set_override',
              'uc2_clear_override',
              'uc2_settings_audit',
              'uc2_policy_summary',
              'uc2_backtest_series',
              'uc2_reset_consumption'
          )
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END
$drop$;


-- ============================================================================
-- PART 1 -- tables
--
-- Each table is created in its 3.0 shape if it does not exist, then brought
-- up to that shape if an older version does exist. Every statement is safe to
-- repeat. Columns are added, never re-created, so stored rows survive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- uc2_settings -- the knobs, one row per scope
--
-- An empty string means "applies to everything". The global row is ('', '')
-- and must have every core value filled in. A row scoped to a warehouse, a
-- SKU, or both is an OVERRIDE: it fills in only what it changes and leaves
-- the rest NULL, which means "inherit". Resolution picks, column by column,
-- the most specific value that is set and has not expired:
--
--     SKU at warehouse  >  SKU everywhere  >  warehouse  >  global
--
-- alpha, classwindowdays and the flag_* thresholds are read from the global
-- row only.
--
-- Seeded from shared_config.json by uc2_seed_settings(). After that this table
-- is authoritative, so an edit made in the UI survives the next engine run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.uc2_settings (
    scopewarehouseid    varchar          NOT NULL DEFAULT '',
    scopeproductid      varchar          NOT NULL DEFAULT '',

    zscore              double precision,   -- 1.65 = 95% service level
    leadtimedays        double precision,   -- trigger to arrival
    coverageperiod      double precision,   -- cover beyond lead time (T)
    sigmaltdays         double precision,   -- lead-time std dev, days

    alpha               double precision,   -- smoothing weight (global only)
    classwindowdays     integer,            -- history used to classify

    validuntil          date,               -- override lapses after this day
    reason              text,               -- why the override exists

    flag_drop_ratio     double precision,   -- thresholds, global row only
    flag_spike_share    double precision,
    flag_gap_multiple   double precision,
    flag_size_multiple  double precision,
    flag_low_conf_days  integer,
    flag_overstock_days double precision,
    flag_near_rop_pct   double precision,

    updatedat           timestamptz      NOT NULL DEFAULT now(),
    updatedby           text             NOT NULL DEFAULT 'config',

    PRIMARY KEY (scopewarehouseid, scopeproductid)
);

-- upgrade from 2.x: new columns, overrides may leave core values NULL
ALTER TABLE public.uc2_settings
    ADD COLUMN IF NOT EXISTS sigmaltdays         double precision,
    ADD COLUMN IF NOT EXISTS alpha               double precision,
    ADD COLUMN IF NOT EXISTS classwindowdays     integer,
    ADD COLUMN IF NOT EXISTS validuntil          date,
    ADD COLUMN IF NOT EXISTS reason              text,
    ADD COLUMN IF NOT EXISTS flag_drop_ratio     double precision,
    ADD COLUMN IF NOT EXISTS flag_spike_share    double precision,
    ADD COLUMN IF NOT EXISTS flag_gap_multiple   double precision,
    ADD COLUMN IF NOT EXISTS flag_size_multiple  double precision,
    ADD COLUMN IF NOT EXISTS flag_low_conf_days  integer,
    ADD COLUMN IF NOT EXISTS flag_overstock_days double precision,
    ADD COLUMN IF NOT EXISTS flag_near_rop_pct   double precision,
    ALTER COLUMN zscore         DROP NOT NULL,
    ALTER COLUMN leadtimedays   DROP NOT NULL,
    ALTER COLUMN coverageperiod DROP NOT NULL,
    DROP COLUMN IF EXISTS tier1days,
    DROP COLUMN IF EXISTS tier2days,
    DROP COLUMN IF EXISTS tier3days;

ALTER TABLE public.uc2_settings ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- uc2_settings_history -- every insert, change and removal of a setting
--
-- Written by a trigger (PART 11), so a change is recorded however it was
-- made: the engine, an override from the UI, or a hand edit in the editor.
-- Answers "why was this ROP 300 on 3 October?" long after the override that
-- caused it has expired.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.uc2_settings_history (
    historyid        bigserial   PRIMARY KEY,
    changedat        timestamptz NOT NULL DEFAULT now(),
    action           text        NOT NULL,     -- INSERT | UPDATE | DELETE
    scopewarehouseid varchar     NOT NULL,
    scopeproductid   varchar     NOT NULL,
    changedby        text,
    oldvalues        jsonb,
    newvalues        jsonb
);

CREATE INDEX IF NOT EXISTS uc2_settings_history_scope_idx
    ON public.uc2_settings_history (scopewarehouseid, scopeproductid, changedat DESC);

ALTER TABLE public.uc2_settings_history ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- uc2_policy_parameters -- the live policy, one row per SKU per warehouse
--
-- Current values only: rebuilt warehouse by warehouse on every run. Each row
-- carries the class, method and settings it was computed with, so an order
-- that fired can be explained afterwards even if the settings have changed.
-- ---------------------------------------------------------------------------

-- An older table (v1: primary key includes asofdate, no isdormant/demanddays)
-- cannot be upgraded column by column -- the key itself is wrong. It holds only
-- derived values that the next compute rebuilds, so drop it and let the CREATE
-- below make the current shape. A v2.x or v3 table is left alone. No CASCADE:
-- if anything (a view) depends on the table, this fails loudly instead.
DO $pp$
DECLARE
    v_pk text[];
BEGIN
    IF to_regclass('public.uc2_policy_parameters') IS NULL THEN
        RETURN;
    END IF;

    SELECT array_agg(a.attname::text ORDER BY a.attname)
      INTO v_pk
      FROM pg_index i
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = 'public.uc2_policy_parameters'::regclass
       AND i.indisprimary;

    IF v_pk IS DISTINCT FROM ARRAY['productid', 'warehouseid']
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public'
                         AND table_name   = 'uc2_policy_parameters'
                         AND column_name  = 'isdormant')
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public'
                         AND table_name   = 'uc2_policy_parameters'
                         AND column_name  = 'demanddays')
    THEN
        RAISE NOTICE 'uc2_policy_parameters is a pre-2.x shape -- dropping it; the next compute rebuilds it';
        DROP TABLE public.uc2_policy_parameters;
    END IF;
END $pp$;

CREATE TABLE IF NOT EXISTS public.uc2_policy_parameters (
    warehouseid            varchar          NOT NULL,
    productid              varchar          NOT NULL,
    asofdate               date             NOT NULL,

    method                 text,            -- ses | sba | mean | none
    demandclass            text,            -- smooth | erratic | intermittent
                                            -- | lumpy | insufficient | dormant
    adi                    double precision,
    cv2                    double precision,
    daysobserved           integer          NOT NULL,
    demanddays             integer          NOT NULL,
    meansize               double precision,
    meaninterval           double precision,
    dayssincelastdemand    integer,
    alpha                  double precision,
    windowdays             integer,

    avgdailydemand         double precision NOT NULL,   -- mu
    stddailydemand         double precision NOT NULL,   -- sigma

    zscore                 double precision NOT NULL,
    leadtimedays           double precision NOT NULL,
    leadtimesource         text,            -- default | warehouse | sku
                                            -- | sku@warehouse
    sigmaltdays            double precision,
    coverageperiod         double precision NOT NULL,

    safetystock            double precision NOT NULL,   -- SS
    reorderpoint           integer          NOT NULL,   -- ROP, whole units
    orderuptolevel         integer          NOT NULL,   -- OUL, whole units

    currentstock           bigint,
    daysofcover            double precision,
    stockstatus            text,            -- Low Stock | Near ROP
                                            -- | Available | Dormant | Unknown
    isdormant              boolean          NOT NULL DEFAULT false,

    flag_demand_dropped    boolean,
    flag_demand_spiked     boolean,
    flag_low_confidence    boolean,
    flag_overstock         boolean,
    flag_possible_stockout boolean,

    computedat             timestamptz      NOT NULL DEFAULT now(),

    PRIMARY KEY (warehouseid, productid)
);

-- upgrade from 2.x
ALTER TABLE public.uc2_policy_parameters
    ADD COLUMN IF NOT EXISTS method                 text,
    ADD COLUMN IF NOT EXISTS demandclass            text,
    ADD COLUMN IF NOT EXISTS adi                    double precision,
    ADD COLUMN IF NOT EXISTS cv2                    double precision,
    ADD COLUMN IF NOT EXISTS meansize               double precision,
    ADD COLUMN IF NOT EXISTS meaninterval           double precision,
    ADD COLUMN IF NOT EXISTS dayssincelastdemand    integer,
    ADD COLUMN IF NOT EXISTS alpha                  double precision,
    ADD COLUMN IF NOT EXISTS windowdays             integer,
    ADD COLUMN IF NOT EXISTS leadtimesource         text,
    ADD COLUMN IF NOT EXISTS sigmaltdays            double precision,
    ADD COLUMN IF NOT EXISTS currentstock           bigint,
    ADD COLUMN IF NOT EXISTS daysofcover            double precision,
    ADD COLUMN IF NOT EXISTS stockstatus            text,
    ADD COLUMN IF NOT EXISTS flag_demand_dropped    boolean,
    ADD COLUMN IF NOT EXISTS flag_demand_spiked     boolean,
    ADD COLUMN IF NOT EXISTS flag_low_confidence    boolean,
    ADD COLUMN IF NOT EXISTS flag_overstock         boolean,
    ADD COLUMN IF NOT EXISTS flag_possible_stockout boolean,
    DROP COLUMN IF EXISTS lookbackdays;

ALTER TABLE public.uc2_policy_parameters ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS uc2_policy_parameters_rop_idx
    ON public.uc2_policy_parameters (warehouseid, reorderpoint)
    WHERE NOT isdormant;

CREATE INDEX IF NOT EXISTS uc2_policy_parameters_status_idx
    ON public.uc2_policy_parameters (warehouseid, stockstatus);


-- ---------------------------------------------------------------------------
-- Read access for the dashboard, which uses the anon key. Same pattern as
-- sql/policies/002_anon_read.sql, for UC2's own tables. Nobody except the
-- engine can write to them directly; the UI changes settings only through
-- uc2_set_override / uc2_clear_override (PART 10).
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.uc2_settings, public.uc2_settings_history,
                public.uc2_policy_parameters
    TO anon, authenticated;

DROP POLICY IF EXISTS uc2_read ON public.uc2_settings;
CREATE POLICY uc2_read ON public.uc2_settings
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS uc2_read ON public.uc2_settings_history;
CREATE POLICY uc2_read ON public.uc2_settings_history
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS uc2_read ON public.uc2_policy_parameters;
CREATE POLICY uc2_read ON public.uc2_policy_parameters
    FOR SELECT TO anon, authenticated USING (true);


-- ============================================================================
-- PART 2 -- uc2_schema_version()
--
-- Called by the engine at startup. If this does not match
-- engines/uc2/version.py, someone edited this file and forgot to apply it --
-- the database is running stale function bodies.
-- ============================================================================
CREATE FUNCTION public.uc2_schema_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 'uc2-3.3'::text
$$;


-- ============================================================================
-- PART 3 -- uc2_seed_settings()
--
-- Writes the global settings row from shared_config.json.
--
--   no global row yet  -> create it from the config
--   p_force = true     -> overwrite every value the config provides
--   otherwise          -> fill in only values that are missing, never
--                         overwrite, so an edit made in the UI survives
--
-- Any value the config leaves out falls back to the default shown here.
-- ============================================================================
CREATE FUNCTION public.uc2_seed_settings(
    p_z               double precision DEFAULT NULL,
    p_lead            double precision DEFAULT NULL,
    p_coverage        double precision DEFAULT NULL,
    p_alpha           double precision DEFAULT NULL,
    p_sigmalt         double precision DEFAULT NULL,
    p_classwindow     integer          DEFAULT NULL,
    p_drop_ratio      double precision DEFAULT NULL,
    p_spike_share     double precision DEFAULT NULL,
    p_gap_multiple    double precision DEFAULT NULL,
    p_size_multiple   double precision DEFAULT NULL,
    p_low_conf_days   integer          DEFAULT NULL,
    p_overstock_days  double precision DEFAULT NULL,
    p_near_rop_pct    double precision DEFAULT NULL,
    p_force           boolean          DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_rows integer;
BEGIN
    PERFORM set_config('uc2.changedby', 'config', true);

    IF NOT EXISTS (SELECT 1 FROM public.uc2_settings
                   WHERE scopewarehouseid = '' AND scopeproductid = '') THEN
        INSERT INTO public.uc2_settings (
            scopewarehouseid, scopeproductid,
            zscore, leadtimedays, coverageperiod, sigmaltdays,
            alpha, classwindowdays,
            flag_drop_ratio, flag_spike_share, flag_gap_multiple,
            flag_size_multiple, flag_low_conf_days, flag_overstock_days,
            flag_near_rop_pct, updatedby)
        VALUES (
            '', '',
            COALESCE(p_z, 1.65), COALESCE(p_lead, 5), COALESCE(p_coverage, 4),
            COALESCE(p_sigmalt, 0),
            COALESCE(p_alpha, 0.033), COALESCE(p_classwindow, 365),
            COALESCE(p_drop_ratio, 0.5), COALESCE(p_spike_share, 0.5),
            COALESCE(p_gap_multiple, 3), COALESCE(p_size_multiple, 3),
            COALESCE(p_low_conf_days, 3), COALESCE(p_overstock_days, 180),
            COALESCE(p_near_rop_pct, 0.2), 'config');
        RETURN 'created';
    END IF;

    IF p_force THEN
        UPDATE public.uc2_settings SET
            zscore              = COALESCE(p_z,              zscore),
            leadtimedays        = COALESCE(p_lead,           leadtimedays),
            coverageperiod      = COALESCE(p_coverage,       coverageperiod),
            sigmaltdays         = COALESCE(p_sigmalt,        sigmaltdays),
            alpha               = COALESCE(p_alpha,          alpha),
            classwindowdays     = COALESCE(p_classwindow,    classwindowdays),
            flag_drop_ratio     = COALESCE(p_drop_ratio,     flag_drop_ratio),
            flag_spike_share    = COALESCE(p_spike_share,    flag_spike_share),
            flag_gap_multiple   = COALESCE(p_gap_multiple,   flag_gap_multiple),
            flag_size_multiple  = COALESCE(p_size_multiple,  flag_size_multiple),
            flag_low_conf_days  = COALESCE(p_low_conf_days,  flag_low_conf_days),
            flag_overstock_days = COALESCE(p_overstock_days, flag_overstock_days),
            flag_near_rop_pct   = COALESCE(p_near_rop_pct,   flag_near_rop_pct),
            updatedat = now(), updatedby = 'config'
        WHERE scopewarehouseid = '' AND scopeproductid = '';
        RETURN 'overwritten';
    END IF;

    UPDATE public.uc2_settings SET
        zscore              = COALESCE(zscore,              p_z,              1.65),
        leadtimedays        = COALESCE(leadtimedays,        p_lead,           5),
        coverageperiod      = COALESCE(coverageperiod,      p_coverage,       4),
        sigmaltdays         = COALESCE(sigmaltdays,         p_sigmalt,        0),
        alpha               = COALESCE(alpha,               p_alpha,          0.033),
        classwindowdays     = COALESCE(classwindowdays,     p_classwindow,    365),
        flag_drop_ratio     = COALESCE(flag_drop_ratio,     p_drop_ratio,     0.5),
        flag_spike_share    = COALESCE(flag_spike_share,    p_spike_share,    0.5),
        flag_gap_multiple   = COALESCE(flag_gap_multiple,   p_gap_multiple,   3),
        flag_size_multiple  = COALESCE(flag_size_multiple,  p_size_multiple,  3),
        flag_low_conf_days  = COALESCE(flag_low_conf_days,  p_low_conf_days,  3),
        flag_overstock_days = COALESCE(flag_overstock_days, p_overstock_days, 180),
        flag_near_rop_pct   = COALESCE(flag_near_rop_pct,   p_near_rop_pct,   0.2),
        updatedat = now(), updatedby = 'config'
    WHERE scopewarehouseid = '' AND scopeproductid = ''
      AND (zscore IS NULL OR leadtimedays IS NULL OR coverageperiod IS NULL
           OR sigmaltdays IS NULL OR alpha IS NULL OR classwindowdays IS NULL
           OR flag_drop_ratio IS NULL OR flag_spike_share IS NULL
           OR flag_gap_multiple IS NULL OR flag_size_multiple IS NULL
           OR flag_low_conf_days IS NULL OR flag_overstock_days IS NULL
           OR flag_near_rop_pct IS NULL);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN CASE WHEN v_rows > 0 THEN 'filled missing values' ELSE 'kept' END;
END
$$;


-- ============================================================================
-- PART 4 -- uc2_ledger_maxday()
--
-- The latest calendar day present in the inventory ledger. Every consumption
-- series is zero-filled up to this day, so all series end together and a
-- fixed-length lookback window returns the same number of days for every SKU.
--
-- Computed once and passed in to the build calls, because a hash bucket only
-- sees its own products and would otherwise compute a different end date.
--
-- THE PIN: the engine may pass an earlier date instead (ledger_through in
-- shared_config.json). Use it when the ledger's latest date is not a real
-- day of data -- e.g. rows stamped with a load time after the real history
-- ends. Every function below treats p_maxday as the last day that exists:
-- rows after it stay in inventory but never become consumption rows.
--
-- NOTE ON TIMESTAMPS: the column type decides how a day boundary is found.
-- If lastupdated is timestamptz it is converted to the target zone first; if
-- it is a naive timestamp it is already local and must not be converted.
-- Getting this backwards shifts every day boundary by eight hours, silently.
-- ============================================================================
CREATE FUNCTION public.uc2_ledger_maxday(p_tz text DEFAULT 'Asia/Singapore')
RETURNS date
LANGUAGE plpgsql
SET statement_timeout = '5min'   -- reads all of inventory; the default limit is too short
AS $$
DECLARE
    v_is_tz boolean;
    v_expr  text;
    v_day   date;
BEGIN
    SELECT (data_type = 'timestamp with time zone') INTO v_is_tz
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'inventory'
      AND column_name  = 'lastupdated';

    v_expr := CASE WHEN v_is_tz
                   THEN format('(i.lastupdated AT TIME ZONE %L)', p_tz)
                   ELSE 'i.lastupdated'
              END;

    EXECUTE format(
        'SELECT MAX(%s)::date FROM public.inventory i WHERE i.warehouseid <> %L',
        v_expr, 'WH001'
    ) INTO v_day;

    RETURN v_day;
END
$$;


-- ============================================================================
-- PART 5 -- uc2_build_consumption()   inventory -> consumption, full rebuild
--
-- The ledger stores the balance AFTER each event, not the change, so the
-- per-event delta is recovered by ordering each (warehouse, product) series in
-- time and subtracting the previous row. A decrease is consumption; an
-- increase is a replenishment arriving and is ignored.
--
-- Three things that look optional and are not:
--
--   * Days with no movement get a row with qtyconsumed = 0. A SKU untouched
--     for a week has no ledger events but still had five days of zero demand.
--     Leave those rows out and the average is over "days something happened".
--
--   * The zero-fill runs to p_maxday -- the last day in the whole ledger --
--     not to the series' own last event. A SKU that stopped moving six weeks
--     ago is having zero-demand days now, and its reorder point should fall.
--
--   * WH001 is excluded. Its decreases are shipments out to subsidiaries.
--
-- BUCKETING: Supabase's HTTP gateway cuts REST calls off at about 60 seconds.
-- Each warehouse is therefore built in p_buckets slices, split by a hash of
-- productid. Series are independent, so a bucket is a self-contained unit of
-- work. Slicing by date instead would be wrong -- the running balance has to
-- carry across the boundary.
-- ============================================================================
CREATE FUNCTION public.uc2_build_consumption(
    p_warehouse text    DEFAULT NULL,
    p_tz        text    DEFAULT 'Asia/Singapore',
    p_buckets   integer DEFAULT 1,
    p_bucket    integer DEFAULT 0,
    p_maxday    date    DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET statement_timeout = '30min'
AS $$
DECLARE
    v_is_tz  boolean;
    v_ts     text;
    v_where  text := '';
    v_maxday date := p_maxday;
    v_rows   bigint;
BEGIN
    IF v_maxday IS NULL THEN
        v_maxday := public.uc2_ledger_maxday(p_tz);
    END IF;
    IF v_maxday IS NULL THEN
        RETURN 0;   -- empty ledger
    END IF;

    SELECT (data_type = 'timestamp with time zone') INTO v_is_tz
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'inventory'
      AND column_name  = 'lastupdated';

    v_ts := CASE WHEN v_is_tz
                 THEN format('(i.lastupdated AT TIME ZONE %L)', p_tz)
                 ELSE 'i.lastupdated'
            END;

    IF p_warehouse IS NOT NULL THEN
        v_where := v_where || format(' AND i.warehouseid = %L', p_warehouse);
    END IF;

    IF p_buckets > 1 THEN
        v_where := v_where || format(
            ' AND mod(abs(hashtext(i.productid)::bigint), %s) = %s',
            p_buckets, p_bucket);
    END IF;

    EXECUTE format($sql$
        INSERT INTO public.consumption
            (consumptionid, warehouseid, productid,
             consumptiondate, closingqty, qtyconsumed)

        WITH deltas AS (
            SELECT
                i.warehouseid,
                i.productid,
                (%1$s)::date AS d,
                i.qtyonhand,
                i.qtyonhand - LAG(i.qtyonhand) OVER (
                    PARTITION BY i.warehouseid, i.productid
                    ORDER BY %1$s, i.inventoryid
                ) AS delta,
                %1$s AS ts,
                i.inventoryid
            FROM public.inventory i
            WHERE i.warehouseid <> 'WH001' %2$s
        ),
        daily AS (
            SELECT
                warehouseid, productid, d,
                SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) AS consumed,
                (ARRAY_AGG(qtyonhand ORDER BY ts DESC, inventoryid DESC))[1]
                    AS close_evt
            FROM deltas
            GROUP BY 1, 2, 3
        ),
        span AS (
            SELECT warehouseid, productid, MIN(d) AS first_day
            FROM daily
            GROUP BY 1, 2
        ),
        grid AS (
            SELECT s.warehouseid, s.productid, gs::date AS d
            FROM span s
            CROSS JOIN LATERAL
                generate_series(s.first_day, %3$L::date, interval '1 day') gs
        ),
        joined AS (
            SELECT
                g.warehouseid, g.productid, g.d,
                COALESCE(dy.consumed, 0) AS consumed,
                dy.close_evt,
                COUNT(dy.close_evt) OVER (
                    PARTITION BY g.warehouseid, g.productid
                    ORDER BY g.d ROWS UNBOUNDED PRECEDING
                ) AS grp
            FROM grid g
            LEFT JOIN daily dy
                   ON dy.warehouseid = g.warehouseid
                  AND dy.productid   = g.productid
                  AND dy.d           = g.d
        )
        SELECT
            'CONS-' || warehouseid || '-' || productid
                    || '-' || to_char(d, 'YYYYMMDD'),
            warehouseid,
            productid,
            (d::timestamp AT TIME ZONE %4$L),
            GREATEST(COALESCE(
                FIRST_VALUE(close_evt) OVER (
                    PARTITION BY warehouseid, productid, grp
                    ORDER BY d ROWS UNBOUNDED PRECEDING
                ), 0), 0)::bigint,
            consumed::bigint
        FROM joined
        ON CONFLICT (warehouseid, productid, consumptiondate) DO UPDATE SET
            closingqty  = EXCLUDED.closingqty,
            qtyconsumed = EXCLUDED.qtyconsumed
    $sql$, v_ts, v_where, v_maxday, p_tz);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END
$$;


-- ============================================================================
-- PART 6 -- uc2_append_consumption()   the daily catch-up
--
-- Everything the full build does, but only for days that are not in
-- consumption yet. This is what the refresh button calls.
--
-- The trick is the seed. Each series picks up its last consumption row and
-- uses the closingqty stored on it as the balance that precedes the first new
-- ledger event -- that is the whole reason closingqty is in the table. Without
-- it the first new event would have no predecessor and its delta would be
-- unknown.
--
-- A series with no consumption rows at all (a SKU stocked for the first time)
-- has no seed and is built from its own first event, exactly as the full
-- build would do.
--
-- A series with no new ledger events still gets rows: it is zero-filled from
-- its last day up to the end of the ledger, carrying its closing balance
-- forward. That is the point -- no movement is real demand information.
--
-- Idempotent. Run it twice on the same day and nothing changes. Skip five days
-- and the next run writes all five.
-- ============================================================================
CREATE FUNCTION public.uc2_append_consumption(
    p_tz     text DEFAULT 'Asia/Singapore',
    p_maxday date DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SET statement_timeout = '30min'
AS $$
DECLARE
    v_is_tz  boolean;
    v_ts     text;
    v_maxday date := p_maxday;
    v_rows   bigint;
BEGIN
    IF v_maxday IS NULL THEN
        v_maxday := public.uc2_ledger_maxday(p_tz);
    END IF;
    IF v_maxday IS NULL THEN
        RETURN 0;
    END IF;

    SELECT (data_type = 'timestamp with time zone') INTO v_is_tz
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'inventory'
      AND column_name  = 'lastupdated';

    v_ts := CASE WHEN v_is_tz
                 THEN format('(i.lastupdated AT TIME ZONE %L)', p_tz)
                 ELSE 'i.lastupdated'
            END;

    EXECUTE format($sql$
        INSERT INTO public.consumption
            (consumptionid, warehouseid, productid,
             consumptiondate, closingqty, qtyconsumed)

        WITH lastday AS (
            SELECT
                warehouseid,
                productid,
                MAX(consumptiondate) AS lastts,
                (MAX(consumptiondate) AT TIME ZONE %2$L)::date AS lastd
            FROM public.consumption
            GROUP BY 1, 2
        ),
        seed AS (
            SELECT
                c.warehouseid, c.productid,
                l.lastd              AS d,
                c.closingqty         AS qty,
                c.consumptiondate    AS ts,
                ''::varchar          AS iid,
                true                 AS is_seed
            FROM public.consumption c
            JOIN lastday l
              ON l.warehouseid = c.warehouseid
             AND l.productid   = c.productid
             AND c.consumptiondate = l.lastts
        ),
        evt AS (
            SELECT
                i.warehouseid, i.productid,
                (%1$s)::date  AS d,
                i.qtyonhand   AS qty,
                %1$s          AS ts,
                i.inventoryid AS iid,
                false         AS is_seed
            FROM public.inventory i
            LEFT JOIN lastday l
                   ON l.warehouseid = i.warehouseid
                  AND l.productid   = i.productid
            WHERE i.warehouseid <> 'WH001'
              AND (l.lastd IS NULL OR (%1$s)::date > l.lastd)
        ),
        ev AS (
            SELECT * FROM seed
            UNION ALL
            SELECT * FROM evt
        ),
        deltas AS (
            SELECT
                warehouseid, productid, d, qty, is_seed, ts, iid,
                qty - LAG(qty) OVER (
                    PARTITION BY warehouseid, productid
                    ORDER BY ts, is_seed DESC, iid
                ) AS delta
            FROM ev
        ),
        daily AS (
            SELECT
                warehouseid, productid, d,
                SUM(CASE WHEN NOT is_seed AND delta < 0 THEN -delta ELSE 0 END)
                    AS consumed,
                (ARRAY_AGG(qty ORDER BY ts DESC, iid DESC))[1] AS close_evt,
                bool_or(is_seed) AS seed_day
            FROM deltas
            GROUP BY 1, 2, 3
        ),
        span AS (
            SELECT
                warehouseid, productid,
                MIN(d) AS first_day,
                bool_or(seed_day) AS has_seed
            FROM daily
            GROUP BY 1, 2
        ),
        grid AS (
            SELECT s.warehouseid, s.productid, gs::date AS d
            FROM span s
            CROSS JOIN LATERAL
                generate_series(s.first_day, %3$L::date, interval '1 day') gs
        ),
        joined AS (
            SELECT
                g.warehouseid, g.productid, g.d,
                COALESCE(dy.consumed, 0) AS consumed,
                dy.close_evt,
                COUNT(dy.close_evt) OVER (
                    PARTITION BY g.warehouseid, g.productid
                    ORDER BY g.d ROWS UNBOUNDED PRECEDING
                ) AS grp
            FROM grid g
            LEFT JOIN daily dy
                   ON dy.warehouseid = g.warehouseid
                  AND dy.productid   = g.productid
                  AND dy.d           = g.d
        ),
        -- Carry the balance forward BEFORE the seed day is filtered out below:
        -- window functions run after WHERE, so filtering in the same SELECT
        -- dropped the seed and wrote closingqty 0 for SKUs with no movement
        -- on the appended days (fixed in uc2-3.2).
        carried AS (
            SELECT
                j.*,
                FIRST_VALUE(j.close_evt) OVER (
                    PARTITION BY j.warehouseid, j.productid, j.grp
                    ORDER BY j.d ROWS UNBOUNDED PRECEDING
                ) AS closing
            FROM joined j
        )
        SELECT
            'CONS-' || c.warehouseid || '-' || c.productid
                    || '-' || to_char(c.d, 'YYYYMMDD'),
            c.warehouseid,
            c.productid,
            (c.d::timestamp AT TIME ZONE %2$L),
            GREATEST(COALESCE(c.closing, 0), 0)::bigint,
            c.consumed::bigint
        FROM carried c
        JOIN span s
          ON s.warehouseid = c.warehouseid
         AND s.productid   = c.productid
        WHERE NOT (s.has_seed AND c.d = s.first_day)   -- seed day already done
        ON CONFLICT (warehouseid, productid, consumptiondate) DO UPDATE SET
            closingqty  = EXCLUDED.closingqty,
            qtyconsumed = EXCLUDED.qtyconsumed
    $sql$, v_ts, p_tz, v_maxday);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END
$$;




-- ============================================================================
-- PART 7 -- uc2_calc()   the one calculation
--
-- Returns the full policy for a set of SKUs WITHOUT writing anything. The
-- stored policy (PART 8) and every dashboard preview (PART 9) come from this
-- function, so a preview can never promise numbers the real run won't give.
--
-- STEP 1 -- CLASSIFY (Syntetos, Boylan & Croston, 2005)
--   Over the classification window (365 days by default):
--     ADI = days observed / days with demand       how often demand happens
--     CV2 = (std dev / mean of the non-zero days)^2   how much sizes vary
--
--                         CV2 < 0.49          CV2 >= 0.49
--       ADI <  1.32       smooth              erratic
--       ADI >= 1.32       intermittent        lumpy
--
--   One demand day -> "insufficient" (no size variation to measure).
--   None           -> "dormant".
--
-- STEP 2 -- FORECAST mu
--   smooth        exponential smoothing (Brown, 1959). Every day contributes
--                 with weight (1-alpha)^age, normalised:
--                     mu = SUM w*d / SUM w
--                 This is SES in closed form; normalising handles SKUs with
--                 less than a full window of history.
--   erratic, intermittent, lumpy
--                 SBA (Syntetos & Boylan, 2005): smooth the size of each
--                 demand (z) and the gap between demands (p) separately, each
--                 weighted by (1-alpha)^j where j counts demands back from
--                 the most recent, then
--                     mu = (1 - alpha/2) * z / p
--                 The (1 - alpha/2) removes the upward bias in Croston's
--                 original z / p.
--   insufficient  plain average over the window
--   dormant       0 -- no reorder point
--
--   p_method = 'simple' skips the classification choice and uses a plain
--   average over the last p_window days, for the dashboard's "simple
--   average" view. The class is still reported, for information.
--
-- STEP 3 -- sigma
--   Exponentially weighted standard deviation of daily demand around mu,
--   using the same day weights. Floored at sqrt(mu), the Poisson value, so a
--   perfectly regular SKU still carries safety stock.
--
-- STEP 4 -- POLICY
--   SS  = z * sqrt( LT * sigma^2 + mu^2 * sigma_LT^2 )
--   ROP = ceil( mu * LT + SS )          at least 1 when mu > 0
--   OUL = ceil( mu * (LT + T) + SS )    at least ROP + 1
--   With sigma_LT = 0 the safety stock formula is the familiar z*sigma*sqrt(LT).
--
-- STEP 5 -- STATUS AND FLAGS  (thresholds from the global settings row)
--   stockstatus   Low Stock  stock <= ROP
--                 Near ROP   stock <= ROP * (1 + near_rop_pct)
--                 Available  above that;   Dormant when mu = 0
--   demand dropped   smooth/erratic: last-30-day average < drop_ratio x
--                      the window average
--                    intermittent/lumpy: days since the last demand >
--                      gap_multiple x the usual gap
--   demand spiked    smooth/erratic: one day > spike_share of the last
--                      30 days' total
--                    intermittent/lumpy: largest order in the last 30 days
--                      > size_multiple x the usual order size
--   low confidence   fewer than low_conf_days demand days in the window
--   overstock        stock / mu > overstock_days, or stock on hand with no
--                    demand at all
--   possible stockout  stock = 0 and no demand in 30 days -- demand may
--                    exist but cannot be seen
--   Gappy items get their own versions of "dropped" and "spiked": a normal
--   month for an intermittent SKU is mostly zeros plus one order, which would
--   trip the smooth-item rules every time.
--
-- Current stock is the closing quantity on the as-of day. Orders arrive
-- instantly in the current simulation, so stock on hand IS the inventory
-- position. THE DAY REAL LEAD TIMES ARE INTRODUCED, stock already on order
-- (stocktransfer rows 'Requested' / 'In Transit', quantities from orderline)
-- must be added to currentstock here -- otherwise the reorder check re-orders
-- the same shortfall every day until the delivery lands.
-- ============================================================================
CREATE FUNCTION public.uc2_calc(
    p_asof      date,
    p_warehouse text             DEFAULT NULL,
    p_product   text             DEFAULT NULL,
    p_method    text             DEFAULT 'policy',
    p_alpha     double precision DEFAULT NULL,
    p_window    integer          DEFAULT NULL,
    p_leadtime  double precision DEFAULT NULL,
    p_sigmalt   double precision DEFAULT NULL,
    p_tz        text             DEFAULT 'Asia/Singapore'
)
RETURNS TABLE (
    warehouseid            varchar,
    productid              varchar,
    asofdate               date,
    method                 text,
    demandclass            text,
    adi                    double precision,
    cv2                    double precision,
    daysobserved           integer,
    demanddays             integer,
    meansize               double precision,
    meaninterval           double precision,
    dayssincelastdemand    integer,
    alpha                  double precision,
    windowdays             integer,
    avgdailydemand         double precision,
    stddailydemand         double precision,
    zscore                 double precision,
    leadtimedays           double precision,
    leadtimesource         text,
    sigmaltdays            double precision,
    coverageperiod         double precision,
    safetystock            double precision,
    reorderpoint           integer,
    orderuptolevel         integer,
    currentstock           bigint,
    daysofcover            double precision,
    stockstatus            text,
    isdormant              boolean,
    flag_demand_dropped    boolean,
    flag_demand_spiked     boolean,
    flag_low_confidence    boolean,
    flag_overstock         boolean,
    flag_possible_stockout boolean
)
LANGUAGE plpgsql
STABLE
SET statement_timeout = '30min'
AS $$
#variable_conflict use_column
DECLARE
    v_method      text := lower(COALESCE(p_method, 'policy'));
    v_a           double precision;
    v_cls         integer;
    v_win         integer;
    v_dropratio   double precision;
    v_spikeshare  double precision;
    v_gapmult     double precision;
    v_sizemult    double precision;
    v_lowconf     integer;
    v_overstock   double precision;
    v_nearpct     double precision;
    v_alpha_set   double precision;
    v_hi          timestamptz;
    v_lo          timestamptz;
BEGIN
    IF p_asof IS NULL THEN
        RAISE EXCEPTION 'uc2_calc needs an as-of date';
    END IF;
    IF v_method NOT IN ('policy', 'simple') THEN
        RAISE EXCEPTION 'method must be ''policy'' or ''simple'', got %', p_method;
    END IF;

    SELECT s.alpha, s.classwindowdays,
           s.flag_drop_ratio, s.flag_spike_share, s.flag_gap_multiple,
           s.flag_size_multiple, s.flag_low_conf_days, s.flag_overstock_days,
           s.flag_near_rop_pct
      INTO v_alpha_set, v_cls,
           v_dropratio, v_spikeshare, v_gapmult,
           v_sizemult, v_lowconf, v_overstock,
           v_nearpct
    FROM public.uc2_settings s
    WHERE s.scopewarehouseid = '' AND s.scopeproductid = '';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'uc2_settings has no global row -- run the engine once to seed it';
    END IF;

    v_a          := COALESCE(p_alpha, v_alpha_set, 0.033);
    v_cls        := COALESCE(v_cls, 365);
    v_dropratio  := COALESCE(v_dropratio, 0.5);
    v_spikeshare := COALESCE(v_spikeshare, 0.5);
    v_gapmult    := COALESCE(v_gapmult, 3);
    v_sizemult   := COALESCE(v_sizemult, 3);
    v_lowconf    := COALESCE(v_lowconf, 3);
    v_overstock  := COALESCE(v_overstock, 180);
    v_nearpct    := COALESCE(v_nearpct, 0.2);

    IF v_a <= 0 OR v_a >= 1 THEN
        RAISE EXCEPTION 'alpha must be between 0 and 1, got %', v_a;
    END IF;

    IF v_method = 'simple' THEN
        v_win := COALESCE(p_window, 30);
        IF v_win < 1 OR v_win > 3650 THEN
            RAISE EXCEPTION 'window must be 1-3650 days, got %', v_win;
        END IF;
    END IF;

    IF p_leadtime IS NOT NULL AND (p_leadtime <= 0 OR p_leadtime > 365) THEN
        RAISE EXCEPTION 'lead time must be 0-365 days, got %', p_leadtime;
    END IF;
    IF p_sigmalt IS NOT NULL AND (p_sigmalt < 0 OR p_sigmalt > 365) THEN
        RAISE EXCEPTION 'lead-time std dev must be 0-365 days, got %', p_sigmalt;
    END IF;

    -- Direct timestamptz bounds so the date filter can use an index.
    v_hi := (p_asof + 1)::timestamp AT TIME ZONE p_tz;
    v_lo := (p_asof - GREATEST(v_cls, COALESCE(v_win, 0), 30))::timestamp
                AT TIME ZONE p_tz;

    RETURN QUERY
    -- NOT MATERIALIZED: daily is read twice (totals and the demand events).
    -- Materialising it would park ~2M rows per warehouse in a temp file;
    -- scanning the table twice is several times faster.
    WITH daily AS NOT MATERIALIZED (
        SELECT c.warehouseid,
               c.productid,
               (p_asof - (c.consumptiondate AT TIME ZONE p_tz)::date) AS age,
               c.qtyconsumed::double precision                        AS q,
               c.closingqty,
               power(1 - v_a, p_asof - (c.consumptiondate AT TIME ZONE p_tz)::date) AS w
        FROM public.consumption c
        WHERE c.warehouseid <> 'WH001'
          AND (p_warehouse IS NULL OR c.warehouseid = p_warehouse)
          AND (p_product   IS NULL OR c.productid   = p_product)
          AND c.consumptiondate >  v_lo
          AND c.consumptiondate <  v_hi
    ),
    agg AS (
        SELECT d.warehouseid,
               d.productid,
               COUNT(*)         FILTER (WHERE d.age < v_cls)              AS n_cls,
               COUNT(*)         FILTER (WHERE d.age < v_cls AND d.q > 0)  AS k_cls,
               AVG(d.q)         FILTER (WHERE d.age < v_cls)              AS mean_cls,
               AVG(d.q)         FILTER (WHERE d.age < v_cls AND d.q > 0)  AS meansize,
               STDDEV_SAMP(d.q) FILTER (WHERE d.age < v_cls AND d.q > 0)  AS sdsize,
               SUM(d.w * d.q)
                                FILTER (WHERE d.age < v_cls)              AS ew_s1,
               SUM(d.w * d.q * d.q)
                                FILTER (WHERE d.age < v_cls)              AS ew_s2,
               SUM(d.w)
                                FILTER (WHERE d.age < v_cls)              AS ew_w,
               AVG(d.q)         FILTER (WHERE d.age < 30)                 AS mean30,
               SUM(d.q)         FILTER (WHERE d.age < 30)                 AS sum30,
               MAX(d.q)         FILTER (WHERE d.age < 30)                 AS max30,
               COUNT(*)         FILTER (WHERE d.age < 30 AND d.q > 0)     AS k30,
               AVG(d.q)         FILTER (WHERE d.age < v_win)              AS mean_win,
               STDDEV_SAMP(d.q) FILTER (WHERE d.age < v_win)              AS sd_win,
               MIN(d.age)       FILTER (WHERE d.age < v_cls AND d.q > 0)  AS since_last,
               MAX(d.closingqty) FILTER (WHERE d.age = 0)                 AS stock
        FROM daily d
        GROUP BY d.warehouseid, d.productid
    ),
    ev AS (
        SELECT d.warehouseid,
               d.productid,
               d.q,
               (ROW_NUMBER() OVER w) - 1  AS j,     -- 0 = most recent demand
               (LEAD(d.age) OVER w) - d.age AS gap  -- days since the one before
        FROM daily d
        WHERE d.q > 0 AND d.age < v_cls
        WINDOW w AS (PARTITION BY d.warehouseid, d.productid ORDER BY d.age)
    ),
    sba AS (
        SELECT e.warehouseid,
               e.productid,
               SUM(power(1 - v_a, e.j) * e.q) / SUM(power(1 - v_a, e.j)) AS zhat,
               SUM(power(1 - v_a, e.j) * e.gap) FILTER (WHERE e.gap IS NOT NULL)
                 / NULLIF(SUM(power(1 - v_a, e.j))
                          FILTER (WHERE e.gap IS NOT NULL), 0)             AS phat
        FROM ev e
        GROUP BY e.warehouseid, e.productid
    ),
    res AS (
        SELECT a.warehouseid,
               a.productid,
               r.z, r.lt, r.lt_spec, r.cover, r.slt
        FROM agg a
        CROSS JOIN LATERAL (
            SELECT
              (array_agg(t.zscore         ORDER BY t.spec DESC)
                 FILTER (WHERE t.zscore         IS NOT NULL))[1] AS z,
              (array_agg(t.leadtimedays   ORDER BY t.spec DESC)
                 FILTER (WHERE t.leadtimedays   IS NOT NULL))[1] AS lt,
              (array_agg(t.spec           ORDER BY t.spec DESC)
                 FILTER (WHERE t.leadtimedays   IS NOT NULL))[1] AS lt_spec,
              (array_agg(t.coverageperiod ORDER BY t.spec DESC)
                 FILTER (WHERE t.coverageperiod IS NOT NULL))[1] AS cover,
              (array_agg(t.sigmaltdays    ORDER BY t.spec DESC)
                 FILTER (WHERE t.sigmaltdays    IS NOT NULL))[1] AS slt
            FROM (
                SELECT s.zscore, s.leadtimedays, s.coverageperiod, s.sigmaltdays,
                       (CASE WHEN s.scopeproductid   <> '' THEN 2 ELSE 0 END)
                     + (CASE WHEN s.scopewarehouseid <> '' THEN 1 ELSE 0 END) AS spec
                FROM public.uc2_settings s
                WHERE (s.scopewarehouseid = '' OR s.scopewarehouseid = a.warehouseid)
                  AND (s.scopeproductid   = '' OR s.scopeproductid   = a.productid)
                  AND (s.validuntil IS NULL OR s.validuntil >= current_date)
            ) t
        ) r
    ),
    cls AS (
        SELECT a.*,
               s.zhat,
               s.phat,
               CASE WHEN a.k_cls > 0
                    THEN a.n_cls::double precision / a.k_cls END          AS adi_v,
               CASE WHEN a.k_cls > 1 AND a.meansize > 0
                    THEN power(COALESCE(a.sdsize, 0) / a.meansize, 2) END AS cv2_v
        FROM agg a
        LEFT JOIN sba s
               ON s.warehouseid = a.warehouseid AND s.productid = a.productid
    ),
    cls2 AS (
        SELECT c.*,
               CASE WHEN c.k_cls = 0 THEN 'dormant'
                    WHEN c.k_cls = 1 THEN 'insufficient'
                    WHEN c.adi_v < 1.32 AND c.cv2_v < 0.49 THEN 'smooth'
                    WHEN c.adi_v < 1.32                    THEN 'erratic'
                    WHEN c.cv2_v < 0.49                    THEN 'intermittent'
                    ELSE                                        'lumpy'
               END AS dclass
        FROM cls c
    ),
    est AS (
        SELECT c.*,
               r.z, r.lt, r.lt_spec, r.cover, r.slt,
               CASE
                 WHEN v_method = 'simple'       THEN COALESCE(c.mean_win, 0)
                 WHEN c.dclass = 'dormant'      THEN 0
                 WHEN c.dclass = 'insufficient' THEN COALESCE(c.mean_cls, 0)
                 WHEN c.dclass = 'smooth'       THEN COALESCE(c.ew_s1 / NULLIF(c.ew_w, 0), 0)
                 ELSE COALESCE((1 - v_a / 2) * c.zhat / NULLIF(c.phat, 0), 0)
               END AS mu,
               CASE
                 WHEN v_method = 'simple'       THEN 'simple'
                 WHEN c.dclass = 'dormant'      THEN 'none'
                 WHEN c.dclass = 'insufficient' THEN 'mean'
                 WHEN c.dclass = 'smooth'       THEN 'ses'
                 ELSE                                'sba'
               END AS meth
        FROM cls2 c
        JOIN res r ON r.warehouseid = c.warehouseid AND r.productid = c.productid
    ),
    est2 AS (
        SELECT e.*,
               CASE
                 WHEN v_method = 'simple' THEN COALESCE(e.sd_win, 0)
                 WHEN e.mu = 0            THEN 0
                 ELSE sqrt(GREATEST(
                        (e.ew_s2 - 2 * e.mu * e.ew_s1 + e.mu * e.mu * e.ew_w)
                          / NULLIF(e.ew_w, 0), 0))
               END AS sigma,
               COALESCE(p_leadtime, e.lt)    AS lte,
               COALESCE(p_sigmalt, e.slt, 0) AS slte
        FROM est e
    ),
    pol AS (
        SELECT e.*,
               CASE WHEN e.mu > 0
                    THEN e.z * sqrt(e.lte * power(GREATEST(e.sigma, sqrt(e.mu)), 2)
                                    + power(e.mu, 2) * power(e.slte, 2))
                    ELSE 0 END AS ss
        FROM est2 e
    ),
    pol2 AS (
        SELECT p.*,
               CASE WHEN p.mu > 0
                    THEN GREATEST(CEIL(p.mu * p.lte + p.ss)::integer, 1)
                    ELSE 0 END AS rop
        FROM pol p
    ),
    pol3 AS (
        SELECT p.*,
               CASE WHEN p.mu > 0
                    THEN GREATEST(CEIL(p.mu * (p.lte + p.cover) + p.ss)::integer,
                                  p.rop + 1)
                    ELSE 0 END AS oul
        FROM pol2 p
    )
    SELECT
        p.warehouseid::varchar,
        p.productid::varchar,
        p_asof,
        p.meth,
        p.dclass,
        p.adi_v,
        p.cv2_v,
        p.n_cls::integer,
        p.k_cls::integer,
        p.meansize,
        p.phat,
        p.since_last::integer,
        CASE WHEN v_method = 'policy' THEN v_a END,
        v_win,
        p.mu,
        p.sigma,
        p.z,
        p.lte,
        CASE WHEN p_leadtime IS NOT NULL THEN 'preview'
             WHEN p.lt_spec = 3 THEN 'sku@warehouse'
             WHEN p.lt_spec = 2 THEN 'sku'
             WHEN p.lt_spec = 1 THEN 'warehouse'
             ELSE 'default' END,
        p.slte,
        p.cover,
        p.ss,
        p.rop,
        p.oul,
        p.stock,
        CASE WHEN p.mu > 0 AND p.stock IS NOT NULL THEN p.stock / p.mu END,
        CASE WHEN p.mu = 0              THEN 'Dormant'
             WHEN p.stock IS NULL       THEN 'Unknown'
             WHEN p.stock <= p.rop      THEN 'Low Stock'
             WHEN p.stock <= p.rop * (1 + v_nearpct) THEN 'Near ROP'
             ELSE 'Available' END,
        (p.mu = 0),
        CASE WHEN p.dclass IN ('smooth', 'erratic')
                  THEN p.mean_cls > 0
                       AND COALESCE(p.mean30, 0) < v_dropratio * p.mean_cls
             WHEN p.dclass IN ('intermittent', 'lumpy')
                  THEN p.since_last > v_gapmult * p.phat
             ELSE false END,
        CASE WHEN p.dclass IN ('smooth', 'erratic')
                  THEN COALESCE(p.sum30, 0) > 0 AND p.max30 > v_spikeshare * p.sum30
             WHEN p.dclass IN ('intermittent', 'lumpy')
                  THEN p.meansize > 0 AND COALESCE(p.max30, 0) > v_sizemult * p.meansize
             ELSE false END,
        (p.k_cls > 0 AND p.k_cls < v_lowconf),
        COALESCE(p.stock > 0 AND (p.mu = 0 OR p.stock / p.mu > v_overstock), false),
        COALESCE(p.stock = 0 AND p.k30 = 0, false)
    FROM pol3 p;
END
$$;


-- ============================================================================
-- PART 8 -- uc2_compute_parameters()   write the live policy
--
-- Recomputes the stored policy for a warehouse, a SKU, or everything, from
-- uc2_calc(). The engine calls it one warehouse at a time so each call stays
-- well inside Supabase's 60-second limit. Overrides call it for just the
-- SKUs they affect.
--
-- The DELETE carries a WHERE clause: Supabase refuses a bare DELETE through
-- the API, even inside a function.
-- ============================================================================
CREATE FUNCTION public.uc2_compute_parameters(
    p_tz        text DEFAULT 'Asia/Singapore',
    p_asof      date DEFAULT NULL,   -- the pin; NULL = latest day in consumption
    p_warehouse text DEFAULT NULL,   -- NULL = every warehouse
    p_product   text DEFAULT NULL    -- NULL = every SKU
)
RETURNS bigint
LANGUAGE plpgsql
SET statement_timeout = '30min'
AS $$
DECLARE
    v_asof date := p_asof;
    v_rows bigint;
BEGIN
    IF v_asof IS NULL THEN
        SELECT (MAX(consumptiondate) AT TIME ZONE p_tz)::date INTO v_asof
        FROM public.consumption;
    END IF;
    IF v_asof IS NULL THEN
        RETURN 0;   -- consumption is empty
    END IF;

    DELETE FROM public.uc2_policy_parameters pp
    WHERE (p_warehouse IS NULL OR pp.warehouseid = p_warehouse)
      AND (p_product   IS NULL OR pp.productid   = p_product);

    INSERT INTO public.uc2_policy_parameters (
        warehouseid, productid, asofdate,
        method, demandclass, adi, cv2, daysobserved, demanddays,
        meansize, meaninterval, dayssincelastdemand, alpha, windowdays,
        avgdailydemand, stddailydemand,
        zscore, leadtimedays, leadtimesource, sigmaltdays, coverageperiod,
        safetystock, reorderpoint, orderuptolevel,
        currentstock, daysofcover, stockstatus, isdormant,
        flag_demand_dropped, flag_demand_spiked, flag_low_confidence,
        flag_overstock, flag_possible_stockout)
    SELECT
        c.warehouseid, c.productid, c.asofdate,
        c.method, c.demandclass, c.adi, c.cv2, c.daysobserved, c.demanddays,
        c.meansize, c.meaninterval, c.dayssincelastdemand, c.alpha, c.windowdays,
        c.avgdailydemand, c.stddailydemand,
        c.zscore, c.leadtimedays, c.leadtimesource, c.sigmaltdays, c.coverageperiod,
        c.safetystock, c.reorderpoint, c.orderuptolevel,
        c.currentstock, c.daysofcover, c.stockstatus, c.isdormant,
        c.flag_demand_dropped, c.flag_demand_spiked, c.flag_low_confidence,
        c.flag_overstock, c.flag_possible_stockout
    FROM public.uc2_calc(v_asof, p_warehouse, p_product,
                         'policy', NULL, NULL, NULL, NULL, p_tz) c;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END
$$;


-- ============================================================================
-- PART 9 -- uc2_preview_parameters()   what-if for the dashboard
--
-- Read-only. Nothing is written, nothing triggers an order.
--
-- Two uses:
--   * the dropdown views: p_method 'policy' with a different p_alpha
--     (Responsive 0.065 / Balanced 0.033 / Stable 0.022), or 'simple' with a
--     p_window in days
--   * the override preview: pass p_leadtime (and p_sigmalt) to see what an
--     override would do before firing it
--
-- Each row comes back beside the live stored values, with:
--   breachstatus  already breached     stock <= live ROP and <= new ROP
--                 newly breached       applying this would trigger an order
--                 no longer breached   the change lifts the SKU out
--                 safe                 above both
--                 dormant / unknown
--   suggestedorderqty  new OUL - stock, for anything breached
--
-- Needs a warehouse or a SKU, so one call never scans the whole database.
-- The as-of day defaults to the live policy's, so a preview is compared
-- against the same day the stored numbers were computed for.
-- ============================================================================
CREATE FUNCTION public.uc2_preview_parameters(
    p_warehouse text,
    p_method    text             DEFAULT 'policy',
    p_alpha     double precision DEFAULT NULL,
    p_window    integer          DEFAULT NULL,
    p_product   text             DEFAULT NULL,
    p_leadtime  double precision DEFAULT NULL,
    p_sigmalt   double precision DEFAULT NULL,
    p_asof      date             DEFAULT NULL,
    p_tz        text             DEFAULT 'Asia/Singapore'
)
RETURNS TABLE (
    warehouseid            varchar,
    productid              varchar,
    asofdate               date,
    method                 text,
    demandclass            text,
    adi                    double precision,
    cv2                    double precision,
    daysobserved           integer,
    demanddays             integer,
    meansize               double precision,
    meaninterval           double precision,
    dayssincelastdemand    integer,
    alpha                  double precision,
    windowdays             integer,
    avgdailydemand         double precision,
    stddailydemand         double precision,
    zscore                 double precision,
    leadtimedays           double precision,
    leadtimesource         text,
    sigmaltdays            double precision,
    coverageperiod         double precision,
    safetystock            double precision,
    reorderpoint           integer,
    orderuptolevel         integer,
    currentstock           bigint,
    daysofcover            double precision,
    stockstatus            text,
    isdormant              boolean,
    flag_demand_dropped    boolean,
    flag_demand_spiked     boolean,
    flag_low_confidence    boolean,
    flag_overstock         boolean,
    flag_possible_stockout boolean,
    live_safetystock       double precision,
    live_reorderpoint      integer,
    live_orderuptolevel    integer,
    breachstatus           text,
    suggestedorderqty      integer
)
LANGUAGE plpgsql
STABLE
SET statement_timeout = '5min'
AS $$
#variable_conflict use_column
DECLARE
    v_asof date := p_asof;
BEGIN
    IF p_warehouse IS NULL AND p_product IS NULL THEN
        RAISE EXCEPTION 'preview needs a warehouse, a SKU, or both';
    END IF;

    IF v_asof IS NULL THEN
        SELECT MAX(pp.asofdate) INTO v_asof FROM public.uc2_policy_parameters pp;
    END IF;
    IF v_asof IS NULL THEN
        SELECT (MAX(c.consumptiondate) AT TIME ZONE p_tz)::date INTO v_asof
        FROM public.consumption c;
    END IF;

    RETURN QUERY
    SELECT
        n.*,
        l.safetystock,
        l.reorderpoint,
        l.orderuptolevel,
        CASE
          WHEN n.isdormant THEN 'dormant'
          WHEN n.currentstock IS NULL THEN 'unknown'
          WHEN n.currentstock <= n.reorderpoint
               AND l.reorderpoint IS NOT NULL AND NOT l.isdormant
               AND n.currentstock <= l.reorderpoint THEN 'already breached'
          WHEN n.currentstock <= n.reorderpoint THEN 'newly breached'
          WHEN l.reorderpoint IS NOT NULL AND NOT l.isdormant
               AND n.currentstock <= l.reorderpoint THEN 'no longer breached'
          ELSE 'safe'
        END,
        CASE
          WHEN NOT n.isdormant AND n.currentstock IS NOT NULL
               AND n.currentstock <= n.reorderpoint
          THEN GREATEST(n.orderuptolevel - n.currentstock, 0)::integer
        END
    FROM public.uc2_calc(v_asof, p_warehouse, p_product, p_method,
                         p_alpha, p_window, p_leadtime, p_sigmalt, p_tz) n
    LEFT JOIN public.uc2_policy_parameters l
           ON l.warehouseid = n.warehouseid AND l.productid = n.productid;
END
$$;


-- ============================================================================
-- PART 10 -- overrides from the UI
--
-- uc2_set_override: set a lead time (and optionally lead-time variability)
-- for a warehouse, a SKU, or a SKU at one warehouse, with a reason and an
-- optional expiry date. Saves it, then recomputes the stored policy for just
-- the SKUs it affects. Returns how many SKUs were recomputed.
--
-- uc2_clear_override: remove one, and recompute.
--
-- Both run with the owner's rights (SECURITY DEFINER) so the dashboard can
-- call them without being able to write to the tables directly -- every
-- change goes through these checks. They are granted to signed-in users only
-- (PART 13); see the note there if your dashboard has no login.
--
-- The global default is not changed here. That goes through
-- shared_config.json and --push-settings, so it stays in the repo.
-- ============================================================================
CREATE FUNCTION public.uc2_set_override(
    p_warehouse  text,
    p_product    text,
    p_leadtime   double precision,
    p_reason     text,
    p_validuntil date             DEFAULT NULL,
    p_sigmalt    double precision DEFAULT NULL,
    p_changedby  text             DEFAULT NULL,
    p_tz         text             DEFAULT 'Asia/Singapore'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5min'
AS $$
DECLARE
    v_wh   text := COALESCE(NULLIF(trim(p_warehouse), ''), '');
    v_pid  text := COALESCE(NULLIF(trim(p_product),   ''), '');
    v_asof date;
BEGIN
    IF v_wh = '' AND v_pid = '' THEN
        RAISE EXCEPTION 'an override needs a warehouse, a SKU, or both -- '
                        'the default lead time is set in shared_config.json';
    END IF;
    IF v_wh <> '' AND NOT EXISTS (SELECT 1 FROM public.warehouse w
                                  WHERE w.warehouseid = v_wh) THEN
        RAISE EXCEPTION 'unknown warehouse %', v_wh;
    END IF;
    IF v_pid <> '' AND NOT EXISTS (SELECT 1 FROM public.product pr
                                   WHERE pr.productid = v_pid) THEN
        RAISE EXCEPTION 'unknown product %', v_pid;
    END IF;
    IF p_leadtime IS NULL OR p_leadtime < 0.5 OR p_leadtime > 180 THEN
        RAISE EXCEPTION 'lead time must be between 0.5 and 180 days, got %', p_leadtime;
    END IF;
    IF p_sigmalt IS NOT NULL AND (p_sigmalt < 0 OR p_sigmalt > 60) THEN
        RAISE EXCEPTION 'lead-time std dev must be between 0 and 60 days, got %', p_sigmalt;
    END IF;
    IF p_validuntil IS NOT NULL AND p_validuntil < current_date THEN
        RAISE EXCEPTION 'expiry date % is already in the past', p_validuntil;
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'an override needs a reason';
    END IF;

    PERFORM set_config('uc2.changedby', COALESCE(p_changedby, 'ui'), true);

    INSERT INTO public.uc2_settings (
        scopewarehouseid, scopeproductid, leadtimedays, sigmaltdays,
        validuntil, reason, updatedat, updatedby)
    VALUES (v_wh, v_pid, p_leadtime, p_sigmalt,
            p_validuntil, trim(p_reason), now(), COALESCE(p_changedby, 'ui'))
    ON CONFLICT (scopewarehouseid, scopeproductid) DO UPDATE SET
        leadtimedays = EXCLUDED.leadtimedays,
        sigmaltdays  = EXCLUDED.sigmaltdays,
        validuntil   = EXCLUDED.validuntil,
        reason       = EXCLUDED.reason,
        updatedat    = EXCLUDED.updatedat,
        updatedby    = EXCLUDED.updatedby;

    SELECT MAX(pp.asofdate) INTO v_asof FROM public.uc2_policy_parameters pp;
    IF v_asof IS NULL THEN
        RETURN 0;   -- no live policy yet; the next engine run picks this up
    END IF;

    RETURN public.uc2_compute_parameters(p_tz, v_asof,
                                         NULLIF(v_wh, ''), NULLIF(v_pid, ''));
END
$$;


CREATE FUNCTION public.uc2_set_service_level(
    p_product   text,
    p_z         double precision,
    p_reason    text,
    p_changedby text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- Per-product service level (uc2-3.3): writes the product-scoped z-score override that
-- uc2_compute_parameters already honours (the most specific non-null z wins). Used by
-- engines/uc2/service_levels.py; the audit trigger logs every change.
DECLARE
    v_pid text := COALESCE(NULLIF(trim(p_product), ''), '');
BEGIN
    IF v_pid = '' OR NOT EXISTS (SELECT 1 FROM public.product pr WHERE pr.productid = v_pid) THEN
        RAISE EXCEPTION 'unknown product %', p_product;
    END IF;
    IF p_z IS NULL OR p_z < 0.5 OR p_z > 4 THEN
        RAISE EXCEPTION 'z must be between 0.5 and 4 (service level 69%% .. 99.99%%), got %', p_z;
    END IF;
    IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'a service level needs a reason';
    END IF;

    PERFORM set_config('uc2.changedby', COALESCE(p_changedby, 'engine'), true);

    INSERT INTO public.uc2_settings (scopewarehouseid, scopeproductid, zscore, reason, updatedat, updatedby)
    VALUES ('', v_pid, p_z, trim(p_reason), now(), COALESCE(p_changedby, 'engine'))
    ON CONFLICT (scopewarehouseid, scopeproductid) DO UPDATE SET
        zscore    = EXCLUDED.zscore,
        reason    = EXCLUDED.reason,
        updatedat = EXCLUDED.updatedat,
        updatedby = EXCLUDED.updatedby;
END
$$;


CREATE FUNCTION public.uc2_clear_override(
    p_warehouse text,
    p_product   text,
    p_changedby text DEFAULT NULL,
    p_tz        text DEFAULT 'Asia/Singapore'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5min'
AS $$
DECLARE
    v_wh   text := COALESCE(NULLIF(trim(p_warehouse), ''), '');
    v_pid  text := COALESCE(NULLIF(trim(p_product),   ''), '');
    v_asof date;
BEGIN
    IF v_wh = '' AND v_pid = '' THEN
        RAISE EXCEPTION 'the global default cannot be cleared';
    END IF;

    PERFORM set_config('uc2.changedby', COALESCE(p_changedby, 'ui'), true);

    DELETE FROM public.uc2_settings s
    WHERE s.scopewarehouseid = v_wh AND s.scopeproductid = v_pid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no override exists for warehouse "%" / SKU "%"', v_wh, v_pid;
    END IF;

    SELECT MAX(pp.asofdate) INTO v_asof FROM public.uc2_policy_parameters pp;
    IF v_asof IS NULL THEN
        RETURN 0;
    END IF;

    RETURN public.uc2_compute_parameters(p_tz, v_asof,
                                         NULLIF(v_wh, ''), NULLIF(v_pid, ''));
END
$$;


-- ============================================================================
-- PART 11 -- the audit trail
--
-- Every insert, update and delete on uc2_settings writes a row to
-- uc2_settings_history with the full before and after values. "Who" comes
-- from the calling function (config, or the user passed to an override);
-- a change typed straight into the SQL Editor is recorded as 'manual edit'.
-- ============================================================================
CREATE FUNCTION public.uc2_settings_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_who text := NULLIF(current_setting('uc2.changedby', true), '');
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO public.uc2_settings_history
            (action, scopewarehouseid, scopeproductid, changedby, oldvalues, newvalues)
        VALUES ('DELETE', OLD.scopewarehouseid, OLD.scopeproductid,
                COALESCE(v_who, 'manual edit'), to_jsonb(OLD), NULL);
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO public.uc2_settings_history
            (action, scopewarehouseid, scopeproductid, changedby, oldvalues, newvalues)
        VALUES ('UPDATE', NEW.scopewarehouseid, NEW.scopeproductid,
                COALESCE(v_who, 'manual edit'), to_jsonb(OLD), to_jsonb(NEW));
    ELSE
        INSERT INTO public.uc2_settings_history
            (action, scopewarehouseid, scopeproductid, changedby, oldvalues, newvalues)
        VALUES ('INSERT', NEW.scopewarehouseid, NEW.scopeproductid,
                COALESCE(v_who, 'manual edit'), NULL, to_jsonb(NEW));
    END IF;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS uc2_settings_audit_trg ON public.uc2_settings;
CREATE TRIGGER uc2_settings_audit_trg
    AFTER INSERT OR UPDATE OR DELETE ON public.uc2_settings
    FOR EACH ROW EXECUTE FUNCTION public.uc2_settings_audit();


-- ============================================================================
-- PART 12 -- read-only helpers
--
-- uc2_policy_summary   one row per demand class: how many SKUs, how many
--                      in each status, how many carry each flag. The engine
--                      prints it after every run.
-- uc2_backtest_series  daily consumption as arrays for a fixed sample of
--                      SKUs, for engines/uc2/backtest.py. The sample is
--                      chosen by hash, so it is the same every run.
-- ============================================================================
CREATE FUNCTION public.uc2_policy_summary()
RETURNS TABLE (
    demandclass            text,
    method                 text,
    skus                   bigint,
    low_stock              bigint,
    near_rop               bigint,
    flag_demand_dropped    bigint,
    flag_demand_spiked     bigint,
    flag_low_confidence    bigint,
    flag_overstock         bigint,
    flag_possible_stockout bigint
)
LANGUAGE sql
STABLE
AS $$
    SELECT pp.demandclass,
           pp.method,
           COUNT(*),
           COUNT(*) FILTER (WHERE pp.stockstatus = 'Low Stock'),
           COUNT(*) FILTER (WHERE pp.stockstatus = 'Near ROP'),
           COUNT(*) FILTER (WHERE pp.flag_demand_dropped),
           COUNT(*) FILTER (WHERE pp.flag_demand_spiked),
           COUNT(*) FILTER (WHERE pp.flag_low_confidence),
           COUNT(*) FILTER (WHERE pp.flag_overstock),
           COUNT(*) FILTER (WHERE pp.flag_possible_stockout)
    FROM public.uc2_policy_parameters pp
    GROUP BY pp.demandclass, pp.method
    ORDER BY COUNT(*) DESC
$$;


CREATE FUNCTION public.uc2_backtest_series(
    p_n    integer DEFAULT 1000,
    p_asof date    DEFAULT NULL,
    p_days integer DEFAULT 366,
    p_tz   text    DEFAULT 'Asia/Singapore'
)
RETURNS TABLE (
    warehouseid varchar,
    productid   varchar,
    demandclass text,
    firstday    date,
    qty         double precision[]
)
LANGUAGE plpgsql
STABLE
SET statement_timeout = '5min'
AS $$
#variable_conflict use_column
DECLARE
    v_asof date := p_asof;
BEGIN
    IF v_asof IS NULL THEN
        SELECT MAX(pp.asofdate) INTO v_asof FROM public.uc2_policy_parameters pp;
    END IF;
    IF v_asof IS NULL THEN
        RAISE EXCEPTION 'no live policy yet -- run the engine first';
    END IF;

    RETURN QUERY
    WITH pick AS (
        SELECT pp.warehouseid, pp.productid, pp.demandclass
        FROM public.uc2_policy_parameters pp
        WHERE NOT pp.isdormant
        ORDER BY md5(pp.warehouseid || '|' || pp.productid)
        LIMIT LEAST(GREATEST(p_n, 1), 1000)
    )
    SELECT k.warehouseid::varchar,
           k.productid::varchar,
           k.demandclass,
           MIN((c.consumptiondate AT TIME ZONE p_tz)::date),
           array_agg(c.qtyconsumed::double precision ORDER BY c.consumptiondate)
    FROM pick k
    JOIN public.consumption c
      ON c.warehouseid = k.warehouseid AND c.productid = k.productid
    WHERE c.consumptiondate >  ((v_asof - p_days)::timestamp AT TIME ZONE p_tz)
      AND c.consumptiondate <  ((v_asof + 1)::timestamp AT TIME ZONE p_tz)
    GROUP BY k.warehouseid, k.productid, k.demandclass;
END
$$;


-- ============================================================================
-- PART 12b -- uc2_reset_consumption()   empty consumption for a rebuild
--
-- WHY: consumption is built by upsert, which updates rows that still match
-- the ledger but never removes rows whose ledger has disappeared. inventory
-- has been emptied and regenerated several times, and every regeneration can
-- leave stale consumption rows behind. Emptying the table and rebuilding is
-- the only way to guarantee it matches the current ledger exactly.
--
-- SAFE because consumption is derived entirely from inventory -- nothing in
-- it cannot be rebuilt. Only consumption is touched: not inventory, not the
-- settings, not their history.
--
-- TRUNCATE rather than DELETE: instant on 10M rows, where a DELETE would run
-- past Supabase's 60-second limit, and not blocked by the API's guard on
-- DELETE without WHERE.
--
-- Guarded twice: engine-only (PART 13), and it refuses to run unless called
-- with p_confirm => 'rebuild', so a stray call cannot wipe the table.
--
-- Called by: python -m engines.uc2.replenishment --rebuild, which only calls
-- it after every other check has passed, then rebuilds straight away.
-- ============================================================================
CREATE FUNCTION public.uc2_reset_consumption(p_confirm text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5min'
AS $$
BEGIN
    IF p_confirm IS DISTINCT FROM 'rebuild' THEN
        RAISE EXCEPTION 'uc2_reset_consumption empties the consumption table -- '
                        'call it with p_confirm => ''rebuild'' to confirm';
    END IF;

    TRUNCATE public.consumption;
    RETURN 'consumption emptied';
END
$$;


-- ============================================================================
-- PART 13 -- who may call what
--
-- Supabase grants every new function to anon and authenticated by default.
-- That is right for the read-only ones and wrong for anything that writes.
--
--   read-only (dashboard may call)   uc2_schema_version, uc2_ledger_maxday,
--                                    uc2_calc, uc2_preview_parameters,
--                                    uc2_policy_summary, uc2_backtest_series
--   overrides (signed-in users)      uc2_set_override, uc2_clear_override
--   engine only (service role)       everything else
--
-- If your dashboard has no login, overrides will be refused. Granting them
-- to anon would let anyone holding the public key change lead times; decide
-- that deliberately rather than by default.
-- ============================================================================
DO $grants$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig, p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname LIKE 'uc2\_%'
          AND p.proname <> 'uc2_settings_audit'
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);

        IF r.proname IN ('uc2_schema_version', 'uc2_ledger_maxday', 'uc2_calc',
                         'uc2_preview_parameters', 'uc2_policy_summary',
                         'uc2_backtest_series') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', r.sig);
        ELSIF r.proname IN ('uc2_set_override', 'uc2_clear_override', 'uc2_set_service_level') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
        ELSE
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
        END IF;
    END LOOP;
END
$grants$;