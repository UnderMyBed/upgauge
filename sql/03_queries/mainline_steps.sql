-- The composition steps of every mainline group inside a window (#203).
--
-- docs/data/carrier-model.md caveat 3: a mainline group's membership changes over time, and
-- each change is an ownership or contract event, not organic growth -- so /explore marks it.
-- Derived from map_mainline_group, never a hand-kept list.
--
-- One row per step. `subject_airline_id` is the series that steps -- the op_airline_id a
-- `g=ml` pivot row carries:
--   joins     the parent gains a carrier at its effective_from
--   leaves    the parent loses it at its effective_to
--   rolls_up  the carrier's own series stops: from effective_from it counts under the parent
--   rolls_out the carrier's own series resumes at effective_to -- unless another row hands it
--             straight to a new parent that same month, in which case it never resumes
-- effective_to is EXCLUSIVE, so it already IS the first month without; no arithmetic.
--
-- A step is CROSSED only when $time_from < month <= $time_to: a step at the window's first
-- month splits nothing, since the whole window sits on one side of it.
WITH steps AS (
    SELECT parent_airline_id AS subject_airline_id,
           effective_from    AS month,
           airline_id        AS other_airline_id,
           'joins'           AS kind
    FROM map_mainline_group
    UNION ALL
    SELECT parent_airline_id, effective_to, airline_id, 'leaves'
    FROM map_mainline_group
    WHERE effective_to IS NOT NULL
    UNION ALL
    SELECT airline_id, effective_from, parent_airline_id, 'rolls_up'
    FROM map_mainline_group
    UNION ALL
    SELECT m.airline_id, m.effective_to, m.parent_airline_id, 'rolls_out'
    FROM map_mainline_group m
    WHERE m.effective_to IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM map_mainline_group n
          WHERE n.airline_id = m.airline_id
            AND n.effective_from = m.effective_to
      )
)
SELECT s.subject_airline_id,
       s.month,
       s.other_airline_id,
       c.carrier_code AS other_code,
       s.kind
FROM steps s
LEFT JOIN dim_carrier c ON c.airline_id = s.other_airline_id
WHERE s.month > $time_from
  AND s.month <= $time_to
ORDER BY s.subject_airline_id, s.month, s.kind, s.other_airline_id
