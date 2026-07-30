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
-- A route absent from the prior window yields NULL, not an enormous improvement: nullif on
-- p12_months_present is what enforces that, so it must not be removed as "redundant".
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
-- Equal weights (0.20). features.md says deliberately dumb, do not over-engineer -- any other
-- weighting would be a number invented here. All five are oriented so HIGHER IS HEALTHIER,
-- including gauge_delta: a downgauge is the warning sign.
scored AS (
    SELECT
        *,
        0.20 * (lf_delta         - avg(lf_delta)         OVER ()) / nullif(stddev_samp(lf_delta)         OVER (), 0)
      + 0.20 * (gauge_delta      - avg(gauge_delta)      OVER ()) / nullif(stddev_samp(gauge_delta)      OVER (), 0)
      + 0.20 * (capacity_delta   - avg(capacity_delta)   OVER ()) / nullif(stddev_samp(capacity_delta)   OVER (), 0)
      + 0.20 * (frequency_delta  - avg(frequency_delta)  OVER ()) / nullif(stddev_samp(frequency_delta)  OVER (), 0)
      + 0.20 * (completion_factor - avg(completion_factor) OVER ()) / nullif(stddev_samp(completion_factor) OVER (), 0)
        AS health_score
    FROM deltas
)
SELECT * FROM scored
ORDER BY op_airline_id, route_key_low, route_key_high
