"""BTS reference tables: the support tables and the code lookups.

Two mechanisms, deliberately kept distinct because they fail differently:

**Support tables** (Master Coordinate, Carrier Decode, AircraftTypes) live in DB 595 and come
through the same `DL_SelectFields` form as T-100 — but with no year/period selects and a
*different subject param*. Getting the subject wrong does not error: BTS answers 200 with its
homepage. That is why the subject is built by the codec rather than pasted as a literal.

**Code lookups** (`L_SERVICE_CLASS`, ...) come from `Download_Lookup.asp` as plain
two-column CSVs, and use the *other* cipher (plain ROT13, letters only).

See docs/data/sources.md.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
from pathlib import Path

import httpx

from pipeline.btscodec import encode_lookup, encode_param
from pipeline.fetch import USER_AGENT, Table

LOOKUP_URL = "https://www.transtats.bts.gov/Download_Lookup.asp"

#: DB 595. Built by the codec so a typo can't silently redirect the fetch to the homepage.
AVIATION_SUPPORT_SUBJECT = encode_param("Aviation Support Tables")


def _support_table(table_id: int, slug: str) -> Table:
    return Table(
        param=encode_param(str(table_id)),
        table_id=table_id,
        slug=slug,
        subject=AVIATION_SUPPORT_SUBJECT,
    )


#: Airports with lat/lon and effective-date ranges — the source for dim_airport.
MASTER_COORDINATE = _support_table(288, "master_coordinate")

#: Carrier identity over time — the source for dim_carrier.
CARRIER_DECODE = _support_table(304, "carrier_decode")

#: Aircraft type codes — the source for dim_aircraft_type.
AIRCRAFT_TYPES = _support_table(300, "aircraft_types")

SUPPORT_TABLES = (MASTER_COORDINATE, CARRIER_DECODE, AIRCRAFT_TYPES)

#: Code lookups worth capturing alongside the data, so the methodology surface can cite them.
CODE_LOOKUPS = frozenset(
    {
        "L_SERVICE_CLASS",
        "L_AIRCRAFT_CONFIG",
        "L_AIRCRAFT_TYPE",
        "L_AIRCRAFT_GROUP",
        "L_CARRIER_GROUP",
        "L_CARRIER_GROUP_NEW",
        "L_DISTANCE_GROUP_500",
    }
)


def lookup_url(name: str) -> str:
    """URL for a `Download_Lookup.asp` code table."""
    return f"{LOOKUP_URL}?Y11x72={encode_lookup(name)}"


def parse_code_lookup(body: str) -> dict[str, str]:
    """Parse a two-column `Code,Description` CSV into a dict.

    Codes stay strings: `079` is a real aircraft type and int-parsing it would break the
    join to the fact table.

    Raises on anything that isn't a lookup CSV — BTS answers 200 with an HTML redirect page
    when a name is wrong, and treating that as empty data would be worse than failing.
    """
    head = body.lstrip()[:200].lower()
    if not head or "<html" in head or "<head" in head or not head.startswith("code,"):
        raise ValueError(f"not a lookup CSV (got {body[:60]!r})")

    rows = csv.reader(io.StringIO(body))
    header = next(rows, None)
    if not header or len(header) < 2:
        raise ValueError(f"not a lookup CSV (header {header!r})")
    return {r[0].strip(): r[1].strip() for r in rows if len(r) >= 2 and r[0].strip()}


def fetch_code_lookup(name: str, client: httpx.Client | None = None) -> dict[str, str]:
    """Fetch and parse one code lookup."""
    owned = client is None
    client = client or httpx.Client(
        timeout=60.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True
    )
    try:
        response = client.get(lookup_url(name))
        response.raise_for_status()
        return parse_code_lookup(response.text)
    finally:
        if owned:
            client.close()


def fetch_support_table(fetcher, table: Table, raw_dir: Path, *, force: bool = False) -> Path:
    """Download one support table into `raw_dir` unless cached. Returns the zip path.

    Support tables have no time dimension, so the cache key is the slug alone. The form
    still carries year/period selects; they are sent as `All` and BTS ignores them.
    """
    path = Path(raw_dir) / f"{table.slug}.zip"
    if path.exists() and not force:
        return path

    body, served = fetcher.download_year(table, "All")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    path.with_suffix(".json").write_text(
        json.dumps(
            {
                "table_id": table.table_id,
                "slug": table.slug,
                "served_filename": served,
                "download_date": dt.date.today().isoformat(),
                "bytes": len(body),
            },
            indent=2,
        )
        + "\n"
    )
    return path
