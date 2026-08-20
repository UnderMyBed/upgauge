"""Pivot SQL rendering: validation, substitution, injection.

Only identifiers are substituted, and only after allowlist validation. Values are always
bound params. Request input never reaches a substitution slot un-validated.
"""

from __future__ import annotations

import duckdb
import pytest

from pipeline.marts import build_database
from pipeline.pivot import PivotError, PivotQuery, render_pivot
from pipeline.tests.test_marts import _warehouse


@pytest.fixture(scope="module")
def con(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("pivot")
    db = tmp_path / "u.duckdb"
    build_database(_warehouse(tmp_path), db)
    return duckdb.connect(str(db))


def q(**kw):
    base = dict(
        grain="segment",
        dimensions=("op_airline_id",),
        measures=("seats",),
        time_from="2015-01",
        time_to="2015-12",
    )
    base.update(kw)
    return PivotQuery(**base)


def test_renders_and_executes(con):
    sql, params = render_pivot(q(), con)
    rows = con.execute(sql, params).fetchall()
    assert rows


def test_values_are_bound_never_interpolated(con):
    sql, params = render_pivot(q(), con)
    assert "2015-01" not in sql, "time range leaked into the SQL text"
    assert params["time_from"] == "2015-01"


def test_unknown_dimension_is_rejected(con):
    with pytest.raises(PivotError, match="dimension"):
        render_pivot(q(dimensions=("not_a_dimension",)), con)


def test_unknown_measure_is_rejected(con):
    with pytest.raises(PivotError, match="measure"):
        render_pivot(q(measures=("profit",)), con)


def test_sql_injection_via_dimension_is_rejected(con):
    """The whole point of the allowlist. This must raise, never substitute."""
    with pytest.raises(PivotError):
        render_pivot(q(dimensions=("op_airline_id; DROP TABLE fct_segment_month--",)), con)


def test_sql_injection_via_sort_is_rejected(con):
    with pytest.raises(PivotError, match="sort"):
        render_pivot(q(sort="seats; DELETE FROM dim_carrier--"), con)


def test_unknown_filter_key_is_rejected(con):
    """A filter key goes through the SAME `_validate_dimension` gate as the dimension list
    (see its docstring) -- so an unknown key must be rejected exactly like an unknown
    dimension, not silently substituted into the WHERE clause."""
    with pytest.raises(PivotError, match="dimension"):
        render_pivot(q(filters=(("not_a_dimension", ("x",)),)), con)


def test_sql_injection_via_filter_key_is_rejected(con):
    """The filter key reaches a WHERE-clause identifier slot (`{columns[0]} IN (...)`) just
    like a dimension key reaches a SELECT/GROUP BY slot. This must raise, never substitute --
    same as test_sql_injection_via_dimension_is_rejected above, but for the filter loop."""
    with pytest.raises(PivotError):
        render_pivot(q(filters=(("op_airline_id; DROP TABLE fct_segment_month--", ("x",)),)), con)


def test_segment_only_dimension_rejected_at_route_grain(con):
    """aircraft_type does not exist on fct_route_month; offering it would render SQL that
    fails at execution rather than validation."""
    with pytest.raises(PivotError, match="grain"):
        render_pivot(q(grain="route", dimensions=("aircraft_type",)), con)


def test_quarantined_rows_are_excluded_and_reported(con):
    """Renamed from `_are_excluded_but_counted`: the original version only asserted the
    `quarantined_rows` COLUMN is present, which cannot detect a broken exclusion -- a FILTER
    silently stripped from a measure's expr (the Task 4 defect this branch's whole-branch
    review found recurring on 8 of 12 measures) would leave that column present and this
    test green regardless. This recomputes `departures_performed` independently from the raw
    fact rows and confirms the pivot's sum actually EXCLUDES the quarantined ones."""
    sql, params = render_pivot(q(measures=("departures_performed",)), con)
    cols = [d[0] for d in con.execute(sql, params).description]
    assert "quarantined_rows" in cols, "the UI must be able to surface the dirt"

    dep_idx = cols.index("departures_performed")
    # A group whose only rows are quarantined sums to NULL (FILTER (WHERE NOT
    # is_quarantined) matches nothing) -- correct (see 301_meta_pivot_measures.sql), and
    # equivalent to 0 for this recomputed total.
    got = sum(row[dep_idx] or 0 for row in con.execute(sql, params).fetchall())

    total_including_quarantined, quarantined_only = con.execute(
        """
        SELECT
            SUM(departures_performed),
            SUM(departures_performed) FILTER (WHERE is_quarantined)
        FROM fct_segment_month
        WHERE year_month BETWEEN '2015-01' AND '2015-12'
        """
    ).fetchone()
    assert quarantined_only, "fixture has no quarantined rows in range -- test can't discriminate"
    assert got == pytest.approx(total_including_quarantined - quarantined_only)


def test_limit_is_bound_and_enforced(con):
    sql, params = render_pivot(q(dimensions=("origin_airport_id",), limit=3), con)
    assert len(con.execute(sql, params).fetchall()) <= 3


def test_derived_measure_is_computed_not_averaged(con):
    sql, _ = render_pivot(q(measures=("load_factor",)), con)
    assert "AVG(" not in sql.upper()
    # Each SUM carries its own quarantine FILTER (see 301_meta_pivot_measures.sql) -- the
    # numerator and denominator are summed from raw rows, never from an averaged ratio.
    assert "NULLIF(SUM(seats) FILTER (WHERE NOT is_quarantined), 0)" in sql


def test_filters_bind_their_values(con):
    sql, params = render_pivot(q(filters=(("op_airline_id", ("19790",)),)), con)
    assert "19790" not in sql
    assert "19790" in str(params.values())


def test_empty_dimensions_is_rejected(con):
    """An empty dimension list renders a stray-comma SELECT that fails at the DuckDB parser,
    not at validation. Deselecting every dimension is a plausible Explorer UI state."""
    with pytest.raises(PivotError, match="dimension"):
        render_pivot(q(dimensions=()), con)


def test_empty_measures_is_rejected(con):
    with pytest.raises(PivotError, match="measure"):
        render_pivot(q(measures=()), con)


def test_non_integer_limit_is_rejected(con):
    with pytest.raises(PivotError, match="limit"):
        render_pivot(q(limit=1.5), con)


def test_negative_limit_is_rejected(con):
    with pytest.raises(PivotError, match="limit"):
        render_pivot(q(limit=-1), con)


def test_zero_limit_is_rejected(con):
    with pytest.raises(PivotError, match="limit"):
        render_pivot(q(limit=0), con)


def test_empty_filter_values_is_rejected(con):
    """A filter with no values renders `IN ()`, invalid SQL -- and a filter with an empty
    value list is not a meaningful request in the first place."""
    with pytest.raises(PivotError, match="filter"):
        render_pivot(q(filters=(("op_airline_id", ()),)), con)


def test_unknown_grouping_is_rejected(con):
    """grouping is documented as "operating" | "mainline" -- anything else must not silently
    fall through to operating semantics, which would render the wrong query without error."""
    with pytest.raises(PivotError, match="grouping"):
        render_pivot(q(grouping="Mainline"), con)


def test_sort_by_carrier_dimension_works_under_operating_grouping(con):
    sql, params = render_pivot(q(sort="op_airline_id", grouping="operating"), con)
    con.execute(sql, params).fetchall()


def test_sort_by_carrier_dimension_works_under_mainline_grouping(con):
    """Regression: under grouping='mainline', op_airline_id's GROUP BY expression becomes
    coalesce(m.parent_airline_id, f.op_airline_id), but ORDER BY was still pointing at the
    bare column name -- which is no longer in the GROUP BY list, so DuckDB's binder rejects
    it. Clicking a column header to sort by carrier is the most natural Explorer interaction
    there is."""
    sql, params = render_pivot(q(sort="op_airline_id", grouping="mainline"), con)
    con.execute(sql, params).fetchall()


def test_sort_desc_normalizes_to_true_when_sort_is_none():
    """`sort_desc` only matters once a sort key exists -- with sort=None, render_pivot reads
    it for the DEFAULT sort's direction, so sort=None/sort_desc=False is not a no-op, it
    renders ASC instead of DESC. But the URL codec's `s=` key only ever carries a direction
    alongside a sort key (`pipeline/urlstate.py`'s `encode`), so that combination has no URL
    representation. Constructing it must normalize rather than silently produce a PivotQuery
    the codec cannot round-trip."""
    normalized = PivotQuery(
        grain="segment",
        dimensions=("op_airline_id",),
        measures=("seats",),
        time_from="2015-01",
        time_to="2015-12",
        sort=None,
        sort_desc=False,
    )
    assert normalized.sort_desc is True
    assert normalized == PivotQuery(
        grain="segment",
        dimensions=("op_airline_id",),
        measures=("seats",),
        time_from="2015-01",
        time_to="2015-12",
        sort=None,
        sort_desc=True,
    )


def test_composite_dimension_filter_emits_least_greatest(con):
    sql, params = render_pivot(q(filters=(("route", ("12478-12892",)),)), con)
    assert (
        "(least(route_key_low, route_key_high) = $f0_0a "
        "AND greatest(route_key_low, route_key_high) = $f0_0b)"
    ) in sql
    assert params["f0_0a"] == "12478"
    assert params["f0_0b"] == "12892"


def test_composite_filter_values_are_or_joined(con):
    """Multiple values keep the IN-list semantics every other dimension has: either route."""
    sql, params = render_pivot(q(filters=(("route", ("12478-12892", "10140-14747")),)), con)
    assert " OR " in sql
    assert "$f0_1a" in sql and "$f0_1b" in sql
    assert params["f0_1a"] == "10140"
    assert params["f0_1b"] == "14747"


def test_composite_filter_rejects_a_malformed_pair(con):
    with pytest.raises(PivotError, match="two ids joined by"):
        render_pivot(q(filters=(("route", ("12478",)),)), con)


def test_composite_filter_rejects_a_non_numeric_pair(con):
    """'JFK-LAX' has two non-empty dash-separated parts, so it clears the arity check and is
    caught by the per-part value rule instead -- which is why its message is the value one.
    Without a per-part check it reaches a bound string param and DuckDB throws an unhandled
    Conversion Error deep inside execution, which the TypeScript call sites only guarded
    PivotError against. Fails if the per-part check is dropped from the pair branch."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("route", ("JFK-LAX",)),)), con)


def test_composite_filter_rejects_ascii_whitespace_around_an_id(con):
    """Same fixture that used to pin the STRIP; it now pins the rejection.

    Stripping made ' 12478 - 12892\t' render rows identical to '12478-12892' -- an unbounded
    family of distinct CDN keys for one query, on the dimension every /route/ page links
    through. The parts are split and checked RAW, so whitespace is not a spelling of an id.

    It also removes a latent cross-language divergence: .strip() strips \x1c-\x1f which JS's
    trim() does not, and trim() strips U+FEFF which .strip() does not. With no strip on either
    side there is no whitespace set for the two runtimes to disagree about."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("route", (" 12478 - 12892\t",)),)), con)


def test_single_column_filter_is_unchanged(con):
    """The existing IN-list path must not move -- 17 goldens depend on it."""
    sql, params = render_pivot(q(filters=(("origin_state", ("OR", "WA")),)), con)
    assert "origin_state IN ($f0_0, $f0_1)" in sql
    assert params["f0_0"] == "OR" and params["f0_1"] == "WA"


def test_output_column_names_match_across_grouping_modes(con):
    """A client (including M3b's TypeScript port) must be able to key a pivot's results by
    column name regardless of which grouping mode was requested."""
    op_sql, op_params = render_pivot(q(grouping="operating"), con)
    ml_sql, ml_params = render_pivot(q(grouping="mainline"), con)
    op_cols = [d[0] for d in con.execute(op_sql, op_params).description]
    ml_cols = [d[0] for d in con.execute(ml_sql, ml_params).description]
    assert op_cols == ml_cols


# M7 Task 2: endpoint_airport_id also spans two columns, but unlike route -- ONE route pair,
# least()/greatest() equality -- its two columns are ALTERNATIVES, compiled to an OR.
# filter_only is the other half of the same catalog row: accepted in a filter, rejected as a
# grouping dimension, since grouping by it would double-count every segment row into both its
# origin's group and its dest's group.
def test_either_mode_filter_compiles_to_an_or_across_both_columns(con):
    """Catches: compiling `either` through the single-column branch (origin only), which is
    the SILENT half of an airport query -- SEA reads 26,710,000 seats instead of 53,373,806
    and every row still renders perfectly."""
    sql, params = render_pivot(q(filters=(("endpoint_airport_id", ("14747",)),)), con)
    assert "(origin_airport_id IN ($f0_0) OR dest_airport_id IN ($f0_0))" in sql
    assert params["f0_0"] == "14747"


def test_either_mode_filter_ors_multiple_values_inside_each_side(con):
    sql, params = render_pivot(q(filters=(("endpoint_airport_id", ("14747", "13930")),)), con)
    assert "(origin_airport_id IN ($f0_0, $f0_1) OR dest_airport_id IN ($f0_0, $f0_1))" in sql
    assert params["f0_0"] == "14747"
    assert params["f0_1"] == "13930"


def test_filter_only_dimension_rejected_as_a_grouping_dimension(con):
    """Catches: allowing endpoint_airport_id in `dimensions`, which double-counts every row."""
    with pytest.raises(PivotError, match="cannot be grouped by; it is filter-only"):
        render_pivot(q(dimensions=("endpoint_airport_id",)), con)


def test_route_still_compiles_as_a_least_greatest_pair_not_an_or(con):
    """Catches: the new `either` branch swallowing `pair` -- which would make a route filter
    match same-airport rows again (18,895 seats on JFK-LAX)."""
    sql, params = render_pivot(q(filters=(("route", ("12478-12892",)),)), con)
    assert "least(route_key_low, route_key_high) = $f0_0a" in sql
    assert " OR dest_airport_id IN " not in sql


# Issue #87. A filter value is bound as a VARCHAR parameter against the dimension's fact
# column, so an integer column handed a value it cannot cast throws a DuckDB Conversion Error
# at EXECUTION -- after proxy.ts has already resolved cacheability and written HTML_CACHE, so
# the 500 is held by a shared cache for up to an hour at a cost of one attacker request.
# Rejecting at render time makes it a PivotError the three call sites already handle.
#
# The type is READ from the catalog (entry["value_type"]), never inferred from the key name:
# aircraft_type is VARCHAR carrying zero-padded codes ('079') and a numeric rule guessed from
# the name would corrupt it. These tests run against a REAL DuckDB connection, so the type
# every assertion below turns on is the introspected one, not a fixture's copy of it.

_INTEGER_DIMENSION_MAXIMA = (
    ("quarter", "127", "128"),
    ("distance_group", "32767", "32768"),
    ("op_airline_id", "2147483647", "2147483648"),
    ("year", "9223372036854775807", "9223372036854775808"),
)


def test_filter_value_rejects_a_non_numeric_value_on_an_integer_dimension(con):
    """Catches: no check at all on the single-column branch. Measured against the real
    warehouse: op_airline_id='2T (1)' -> Conversion Error, INT32."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("op_airline_id", ("2T (1)",)),)), con)


def test_filter_value_rejects_all_digits_that_overflow_smallint(con):
    """THE test a digits-only check cannot pass. Every character of '99999' is a digit and it
    still throws (INT16 max 32767). A rule copied from the old route branch (\\A[0-9]+\\Z)
    passes a test written with '2T (1)' and leaves this 500 live."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("distance_group", ("99999",)),)), con)


def test_filter_value_rejects_all_digits_that_overflow_tinyint(con):
    """Same shape one width down: quarter is TINYINT, max 127, and '999' throws."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("quarter", ("999",)),)), con)


def test_filter_value_accepts_each_integer_types_exact_maximum(con):
    """The bound is inclusive. `>=` instead of `>` would 400 four permalinks that work."""
    for key, maximum, _over in _INTEGER_DIMENSION_MAXIMA:
        _, params = render_pivot(q(filters=((key, (maximum,)),)), con)
        assert params["f0_0"] == maximum


def test_filter_value_rejects_each_integer_types_maximum_plus_one(con):
    """The BIGINT row is why the TypeScript mirror needs BigInt rather than Number: measured,
    Number('9223372036854775808') <= 9223372036854775807 is True because both sides round to
    2**63 as doubles. Python's int is arbitrary-precision and has no such trap, which is
    exactly why this pair must be tested on BOTH sides rather than reasoned across."""
    for key, _maximum, over in _INTEGER_DIMENSION_MAXIMA:
        with pytest.raises(PivotError, match="must be a plain whole number"):
            render_pivot(q(filters=((key, (over,)),)), con)


def test_the_rule_agrees_with_duckdb_at_every_integer_boundary(con):
    """The oracle: the rule's verdict and DuckDB's must agree at each type's exact boundary.

    Three assertions per dimension, and each earns its place:
      1. render_pivot ACCEPTS `maximum`, and the SQL it renders really executes;
      2. render_pivot REJECTS `maximum + 1` -- through render_pivot, so the RULE is what runs;
      3. DuckDB itself throws on `maximum + 1`, which is WHY (2) has to reject it.

    The maxima are the hand-written tuple above; this test does NOT introspect them. What it
    does is make a wrong one unable to pass: too narrow and (3) stops throwing, too wide and
    (1) stops executing.

    (3) substitutes the bad value into the params of the ALREADY-RENDERED SQL, which is what
    makes it a demonstration of the cached 500 rather than a restatement of the rule -- it
    drives the query the server would have run, against a real database, and inlines no SQL of
    its own. That route bypasses _check_filter_value entirely, so (3) cannot stand alone: (2)
    is the assertion that exercises the rule, and without it, widening a maximum in
    pipeline/pivot.py leaves this test green."""
    for key, maximum, over in _INTEGER_DIMENSION_MAXIMA:
        sql, params = render_pivot(q(filters=((key, (maximum,)),)), con)
        con.execute(sql, params).fetchall()

        with pytest.raises(PivotError, match="must be a plain whole number"):
            render_pivot(q(filters=((key, (over,)),)), con)

        params["f0_0"] = over
        with pytest.raises(duckdb.ConversionException):
            con.execute(sql, params).fetchall()


def test_filter_value_leaves_a_varchar_dimension_unchecked(con):
    """Catches: applying the integer rule to VARCHAR. aircraft_type '079' is a real code and
    must survive as the STRING '079' -- int-parsing it to 79 breaks the join silently
    (CLAUDE.md's zero-padding gotcha). This is what proves the type is read, not guessed."""
    sql, params = render_pivot(q(filters=(("aircraft_type", ("079",)),)), con)
    assert "aircraft_type IN ($f0_0)" in sql
    assert params["f0_0"] == "079"


def test_filter_value_leaves_a_varchar_dimension_unchecked_for_junk(con):
    """origin_state='2T (1)' returns zero rows against the real warehouse -- the ordinary
    no-match shape every query here already handles, not an error."""
    _, params = render_pivot(q(filters=(("origin_state", ("2T (1)",)),)), con)
    assert params["f0_0"] == "2T (1)"


def test_filter_value_rejects_non_canonical_spellings_duckdb_would_accept(con):
    """Measured against the real warehouse: every one of these renders the byte-identical
    /carrier/DL page as canonical '19790', so each is a distinct CDN cache key for the same
    bytes -- and the leading-zero and underscore families are UNBOUNDED, capped only by URL
    length. This is the #52 spelling axis, and `f` is where it was left open."""
    for spelling in (
        "0019790",
        "000000019790",
        "+19790",
        " 19790 ",
        "1.979e4",
        "19790.0",
        "19790.",
        "0x4D5E",
        "19_790",
        "1_9_7_9_0",
    ):
        with pytest.raises(PivotError, match="must be a plain whole number"):
            render_pivot(q(filters=(("op_airline_id", (spelling,)),)), con)


def test_filter_value_rejects_a_trailing_newline(con):
    """The anchor test, and the reason the pattern is \\A...\\Z and never ^...$. Python's `$`
    ALSO matches before a trailing newline, so `^...$` admits '19790\\n' -- which DuckDB casts
    to 19790, making it one more spelling of the same page. JavaScript's `$` (no /m) does not,
    so ^...$ here would silently diverge from app/src/lib/pivot/render.ts."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("op_airline_id", ("19790\n",)),)), con)


def test_filter_value_rejects_a_negative_value(con):
    """'-1' casts fine and returns zero rows, so this is the cache-key argument rather than
    the crash one: an unbounded family of distinct keys for empty results. encode() never
    emits one."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("op_airline_id", ("-1",)),)), con)


def test_filter_value_checks_every_value_in_the_list(con):
    """Catches: validating values[0] and binding the rest unchecked -- which passes every
    single-value test in this file and leaves the 500 reachable with one extra comma."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("op_airline_id", ("19790", "2T (1)")),)), con)


def test_filter_value_error_names_the_value_and_the_key(con):
    """app/smoke.sh needles assert on the substring 'must be a plain whole number' plus the
    dimension key, inside the /explore error page's role="alert" region. Both halves are
    load-bearing, and the message is ASCII only."""
    with pytest.raises(PivotError) as excinfo:
        render_pivot(q(filters=(("op_airline_id", ("2T (1)",)),)), con)
    assert "2T (1)" in str(excinfo.value)
    assert "op_airline_id" in str(excinfo.value)
    assert "must be a plain whole number from 0 to 2147483647" in str(excinfo.value)


def test_filter_value_rejects_a_bad_value_through_the_either_branch(con):
    """Catches: the check wired into the single-column branch only. endpoint_airport_id is
    'either'-mode and takes its own code path, so it needs its own coverage."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("endpoint_airport_id", ("2T (1)",)),)), con)


def test_filter_value_rejects_an_overflowing_id_inside_a_composite_pair(con):
    """The route branch's OLD check was a digits-only regex per part, so this passed
    validation and threw inside DuckDB -- a second live 500 of the same class."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("route", ("99999999999-99999999999",)),)), con)


def test_filter_value_rejects_every_shape_of_whitespace_in_a_composite_pair(con):
    """The measured family, not one example of it. While the strip was in place each of these
    returned rows identical to route:12478-12892, and the runs may be any length, so the family
    is unbounded."""
    for spelling in (
        "  12478-12892",
        "12478-12892\t",
        "\n\n 12478-12892 \t",
        "12478 - 12892",
        " 12478  -  12892 ",
    ):
        with pytest.raises(PivotError, match="must be a plain whole number"):
            render_pivot(q(filters=(("route", (spelling,)),)), con)


def test_filter_value_rejects_a_digit_string_longer_than_pythons_int_parse_limit(con):
    """The length guard's own reason, and it is CORRECTNESS here rather than cost.

    `f` values are unbounded in length (bounds.ts exempts `f`), and int() raises
    ValueError("Exceeds the limit (4300 digits)") above sys.get_int_max_str_digits(). Without
    the `len(value) > len(str(maximum))` clause this escapes _check_filter_value as a bare
    ValueError -- not a PivotError -- and sails past the guard at every one of the three call
    sites, which catch PivotError only. Deleting that clause turns this test red with a
    ValueError, which is exactly the bug it names.

    The TypeScript mirror has no equivalent failure: BigInt() parses any length, so its own
    length guard is a parse-COST bound and no unit test can distinguish it. Said plainly in
    that comment rather than implied to be test-covered."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("year", ("9" * 4301,)),)), con)


def test_filter_value_rejects_a_composite_pair_whose_second_part_is_bad(con):
    """Catches: checking parts[0] only. The first id here is perfectly valid."""
    with pytest.raises(PivotError, match="must be a plain whole number"):
        render_pivot(q(filters=(("route", ("12478-99999999999",)),)), con)
