-- The freshness stamp. DATA AS OF is a first-class UI element and the product's credibility
-- rests on it, so it is read from the data on every request rather than configured -- a
-- hand-set value can disagree with what is actually being served.
--
-- No Python caller yet; it exists so the server has no excuse to inline one.
SELECT max(year_month) AS data_as_of FROM fct_segment_month
