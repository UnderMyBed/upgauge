-- Substring search across the three entity types that have pages. City markets are absent on
-- purpose: dim_city_market resolves a name but there is no /city-market/ page to link to.
--
-- Unlike the {{IDS}} lookups, this binds `$pattern` as an ORDINARY parameter, three times. The
-- {{IDS}} substitution exists only because a variable-length IN list cannot be bound, and it
-- replaces the FIRST occurrence only -- so a token used three times would be silently wrong
-- here. A scalar pattern has no such problem. Do not "make it consistent" with its siblings.
--
-- The caller builds the pattern ('%' || q || '%') and is responsible for escaping % and _ in q.
-- ILIKE is DuckDB's case-insensitive LIKE.
--
-- `ESCAPE '\'` is not decorative: DuckDB's LIKE/ILIKE has NO default escape character (measured
-- -- 'a%b' ILIKE '%a\%b%' is FALSE with no ESCAPE clause; the backslash is matched as a literal
-- backslash, which 'a%b' does not contain). Without this clause a caller has no way to search
-- for a name that itself contains a literal '%' or '_' -- app/src/lib/search.ts's
-- `likePattern()` doubles a literal backslash and backslash-escapes '%' and '_' in the user's
-- text before wrapping it in the outer wildcard '%', and this clause is what makes that
-- escaping mean anything. Every fixture in this file's own comments (Portland, Alaska, the
-- three collision codes) is unaffected either way -- none of those names contain '%' or '_'.
--
-- Each arm carries its own fact-presence filter. Without them the airport arm alone returns
-- historical and non-US rows that have no page, and every one of them would render as a link
-- to a 404.
--
-- Measured against the built database (task-4-report.md has the full fixture list):
--   'portland' -> 4 airports: HIO (Portland Hillsboro), PDX (Portland International),
--                 PWM (Portland International Jetport, MAINE, not Oregon), TTD (Portland
--                 Troutdale). A count-only assertion passes against an implementation that
--                 silently drops PWM; assert all four codes by name.
--   'alaska'   -> 8 rows: DUT (Unalaska Airport) plus 7 carriers, in this file's own
--                 `ORDER BY 1, 2` order: 4Y, 5V, AS, J5, JN, K2, RVQ. AS ranks third here --
--                 app/src/lib/search.ts re-ranks so a name that STARTS WITH the query sorts
--                 before one that merely contains it, which is what puts AS first on the page.
SELECT 'airport' AS kind, a.code AS code, a.name AS name
FROM dim_airport a
WHERE a.is_latest
  AND a.name ILIKE $pattern ESCAPE '\'
  AND a.airport_id IN (
      SELECT origin_airport_id FROM fct_segment_month
      UNION
      SELECT dest_airport_id FROM fct_segment_month
  )
UNION ALL
SELECT 'carrier', c.carrier_code, c.unique_name
FROM dim_carrier c
WHERE c.unique_name ILIKE $pattern ESCAPE '\'
  AND c.airline_id IN (SELECT op_airline_id FROM fct_segment_month)
UNION ALL
SELECT 'aircraft', t.short_name, t.name
FROM dim_aircraft_type t
WHERE t.name ILIKE $pattern ESCAPE '\'
  AND t.code IN (SELECT aircraft_type FROM fct_segment_month)
ORDER BY 1, 2
