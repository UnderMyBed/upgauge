-- upgauge: table
-- object: mart_route_health
--
-- Route Health v0 -- deliberately dumb, per docs/product/features.md. The COMPONENTS are the
-- insight; health_score is only a sort key, and the UI must label it a heuristic.
--
-- The one materialised table in the database, because trailing-12 windowing over the whole
-- window is the only genuinely expensive thing in the layer.
--
-- The one object allowed to STORE derived columns. That is safe because the grain has no time
-- dimension: one row per (carrier, undirected route) is both the finest and the coarsest this
-- table gets, so there is no legitimate GROUP BY of it and nothing an AVG() could corrupt.
-- If this table is ever given a time grain, the derived columns must come back out.
-- See docs/data/model.md.
--
-- UNDIRECTED. T-100 files each direction separately, so a directed grain would split every
-- route in two and halve each half's departures against the <30 floor below.
WITH bounds AS (
    SELECT max(strptime(year_month, '%Y-%m')) AS end_m FROM fct_route_month
),
windows AS (
    SELECT
        strftime(end_m - INTERVAL 11 MONTH, '%Y-%m') AS t12_start_month,
        strftime(end_m,                     '%Y-%m') AS t12_end_month,
        strftime(end_m - INTERVAL 23 MONTH, '%Y-%m') AS p12_start_month,
        strftime(end_m - INTERVAL 12 MONTH, '%Y-%m') AS p12_end_month
    FROM bounds
),
-- 'YYYY-MM' strings order and BETWEEN correctly, so no per-row date parsing is needed.
agg AS (
    SELECT
        r.op_airline_id,
        r.route_key_low,
        r.route_key_high,
        w.*,

        count(DISTINCT r.year_month) FILTER (
            WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_months_present,
        sum(r.seats)                FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_seats,
        sum(r.passengers)           FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_passengers,
        sum(r.departures_performed) FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_departures_performed,
        sum(r.departures_scheduled) FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_departures_scheduled,
        sum(r.quarantined_rows)     FILTER (WHERE r.year_month BETWEEN w.t12_start_month AND w.t12_end_month) AS t12_quarantined_rows,

        count(DISTINCT r.year_month) FILTER (
            WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_months_present,
        sum(r.seats)                FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_seats,
        sum(r.passengers)           FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_passengers,
        sum(r.departures_performed) FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_departures_performed,
        sum(r.departures_scheduled) FILTER (WHERE r.year_month BETWEEN w.p12_start_month AND w.p12_end_month) AS p12_departures_scheduled
    FROM fct_route_month r
    CROSS JOIN windows w
    WHERE r.year_month BETWEEN w.p12_start_month AND w.t12_end_month
    GROUP BY r.op_airline_id, r.route_key_low, r.route_key_high,
             w.t12_start_month, w.t12_end_month, w.p12_start_month, w.p12_end_month
),
-- Every ratio below comes from SUMMED numerator and denominator. Never an averaged ratio.
-- A route absent from the prior window yields NULL, not an enormous improvement. The real
-- guard is the nullif() on every p12_* denominator: SUM(...) FILTER (WHERE <no rows>)
-- already returns NULL, not 0, in DuckDB, so nullif's NULL-in/NULL-out propagates on its
-- own. The `CASE WHEN p12_months_present = 0 THEN NULL ... END` below is documentation,
-- not the load-bearing mechanism -- deleting all four is a proven no-op today (identical
-- byte-for-byte mart). Keep it anyway: it is correct defence against a future coalesce()
-- on the p12 sums, which WOULD change behaviour. See docs/data/model.md.
derived AS (
    SELECT
        *,
        t12_passengers / nullif(t12_seats, 0) AS lf_t12,
        CASE WHEN p12_months_present = 0 THEN NULL
             ELSE p12_passengers / nullif(p12_seats, 0) END AS lf_p12,
        t12_seats / nullif(t12_departures_performed, 0) AS gauge_t12,
        CASE WHEN p12_months_present = 0 THEN NULL
             ELSE p12_seats / nullif(p12_departures_performed, 0) END AS gauge_p12,
        t12_departures_performed / nullif(t12_departures_scheduled, 0) AS completion_factor
    FROM agg
    WHERE t12_departures_performed >= 30   -- performed, NOT scheduled
),
deltas AS (
    SELECT
        *,
        lf_t12 - lf_p12       AS lf_delta,
        gauge_t12 - gauge_p12 AS gauge_delta,
        CASE WHEN p12_months_present = 0 THEN NULL
             ELSE t12_seats / nullif(p12_seats, 0) - 1 END AS capacity_delta,
        CASE WHEN p12_months_present = 0 THEN NULL
             ELSE t12_departures_performed
                  / nullif(p12_departures_performed, 0) - 1 END AS frequency_delta
    FROM derived
),
-- Four INDEPENDENT axes, equal 0.25. capacity_delta is deliberately NOT among them: in log
-- space it is exactly frequency + gauge (verified to 9.37e-16 over all 7,392 finite rows --
-- docs/data/model.md), so scoring it scores those two a second time. It keeps its column and
-- stays on the page; it is the COMPOSITE it has no place in.
--
-- The ratios are logged because the raw form is unbounded and asymmetric: capacity_delta
-- reached +2348.658 on the real warehouse, its own outliers inflated its own stddev, and
-- completion_factor was left contributing 1.6% of a nominally 20% share. In logs a halving and
-- a doubling get equal magnitude; in raw ratios they are -0.5 and +1.0.
axes AS (
    SELECT
        *,
        ln(nullif(gauge_t12, 0) / nullif(gauge_p12, 0))                    AS gauge_log,
        ln(nullif(t12_departures_performed, 0)
           / nullif(p12_departures_performed, 0))                          AS freq_log,
        -- CASE, not a bare least(): DuckDB's least() IGNORES NULLs, so least(NULL, 1.5)
        -- returns 1.5 and fabricates a near-perfect completion rate for the 180 routes that
        -- filed no schedule at all. See docs/data/model.md.
        CASE WHEN completion_factor IS NULL THEN NULL
             ELSE least(completion_factor, 1.5) END                        AS completion_capped
    FROM deltas
),
z AS (
    SELECT
        *,
        (lf_delta          - avg(lf_delta)          OVER ()) / nullif(stddev_samp(lf_delta)          OVER (), 0) AS z_lf,
        (gauge_log         - avg(gauge_log)         OVER ()) / nullif(stddev_samp(gauge_log)         OVER (), 0) AS z_gauge,
        (freq_log          - avg(freq_log)          OVER ()) / nullif(stddev_samp(freq_log)         OVER (), 0) AS z_freq,
        (completion_capped - avg(completion_capped) OVER ()) / nullif(stddev_samp(completion_capped) OVER (), 0) AS z_completion
    FROM axes
),
-- Clamped at +/-3 so no single axis can move the composite by more than 0.75. Uniform, with no
-- per-component threshold to invent. Logging alone fixes capacity and frequency but BREAKS
-- gauge: a three-seat change on a nine-seat aircraft is a huge log ratio, and VD CPX-VQS
-- reaches z_gauge = -17.28 unclamped. Touches 470 of the 7,267 scored rows.
--
-- Every clamp is a CASE for the same reason the cap above is: greatest(least(NULL,3),-3)
-- returns -3, which would score all 8,080 rows and destroy the three-reason NULL contract
-- (docs/product/features.md).
scored AS (
    SELECT
        * EXCLUDE (gauge_log, freq_log, completion_capped, z_lf, z_gauge, z_freq, z_completion),
        0.25 * (
            CASE WHEN z_lf         IS NULL THEN NULL ELSE greatest(least(z_lf,         3), -3) END
          + CASE WHEN z_gauge      IS NULL THEN NULL ELSE greatest(least(z_gauge,      3), -3) END
          + CASE WHEN z_freq       IS NULL THEN NULL ELSE greatest(least(z_freq,       3), -3) END
          + CASE WHEN z_completion IS NULL THEN NULL ELSE greatest(least(z_completion, 3), -3) END
        ) AS health_score
    FROM z
)
SELECT * FROM scored
ORDER BY op_airline_id, route_key_low, route_key_high
