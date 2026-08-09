"""Fetch BTS T-100 zips into data/raw/.

PREZIP is a dead end for T-100 (every file there is dated 2015-09-02), so the only path is
the `DL_SelectFields.aspx` form. It is ASP.NET WebForms, which makes each download stateful:
GET the form for cookies and `__VIEWSTATE`, then POST them back with the field selection.

See docs/data/sources.md for the endpoint detail and the measured timings.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import re
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode

import httpx

BASE_URL = "https://www.transtats.bts.gov/DL_SelectFields.aspx"
USER_AGENT = "upguage-ingest (+https://upgauge.shipman.dev)"

#: Checkboxes on the form that control the request rather than selecting a data column.
CONTROL_CHECKBOXES = frozenset(
    {
        "chkAllVars",
        "chkAllGroups",
        "chkDownloadZip",
        "chkshowNull",
        "chkMergeSub",
        "chkDocument",
        "chkTermDef",
    }
)

#: A full year of T-100 is ~12MB; a month ~1.25MB. Anything this small is a truncated or
#: error response masquerading as a download.
MIN_ZIP_BYTES = 1024

#: The history window. Widening it is a product decision (docs/data/sources.md), not a flag.
WINDOW_START = 2015


@dataclass(frozen=True)
class Table:
    """A TranStats table. `param` is the obfuscated Table_ID used in the query string."""

    param: str
    table_id: int
    slug: str
    subject: str = "Nv4 Pn44vr45"  # "Air Carriers"

    @property
    def url(self) -> str:
        return f"{BASE_URL}?gnoyr_VQ={self.param}&QO_fu146_anzr={self.subject.replace(' ', '+')}"


#: T-100 Domestic Segment (U.S. Carriers) — the v0 dataset.
T100D_SEGMENT_US = Table(param="FIM", table_id=259, slug="t100d_segment_us")


class FetchError(RuntimeError):
    """Base class for fetch failures."""


class ViewStateError(FetchError):
    """The form had no `__VIEWSTATE` — BTS changed the page. Don't POST junk at it."""


class NotAZipError(FetchError):
    """BTS answered 200 with something that isn't a zip (usually an HTML error page)."""


class ShortResponseError(FetchError):
    """The zip came back implausibly small — a partial or error response."""


def parse_hidden_fields(html: str) -> dict[str, str]:
    """Pull the ASP.NET hidden inputs out of the form."""
    hidden = {}
    for name in (
        "__VIEWSTATE",
        "__VIEWSTATEGENERATOR",
        "__EVENTVALIDATION",
        "__EVENTTARGET",
        "__EVENTARGUMENT",
        "__LASTFOCUS",
    ):
        m = re.search(rf'id="{name}"[^>]*value="([^"]*)"', html) or re.search(
            rf'name="{name}"[^>]*value="([^"]*)"', html
        )
        if m:
            hidden[name] = m.group(1)
    if not hidden.get("__VIEWSTATE"):
        raise ViewStateError("no __VIEWSTATE in form — BTS changed the page")
    return hidden


def parse_data_fields(html: str) -> list[str]:
    """The data-column checkboxes, in form order, excluding the control checkboxes."""
    names = re.findall(r'<input[^>]*type="?checkbox"?[^>]*name="([^"]+)"', html, re.I)
    return [n for n in names if n not in CONTROL_CHECKBOXES]


def build_download_payload(
    hidden: dict[str, str], fields: list[str], year: int, period: str = "All"
) -> list[tuple[str, str]]:
    """The POST body. `period='All'` pulls a whole year — 12 requests instead of 144."""
    payload: list[tuple[str, str]] = [
        ("__EVENTTARGET", hidden.get("__EVENTTARGET", "")),
        ("__EVENTARGUMENT", hidden.get("__EVENTARGUMENT", "")),
        ("__LASTFOCUS", hidden.get("__LASTFOCUS", "")),
        ("__VIEWSTATE", hidden["__VIEWSTATE"]),
        ("__VIEWSTATEGENERATOR", hidden.get("__VIEWSTATEGENERATOR", "")),
        ("__EVENTVALIDATION", hidden.get("__EVENTVALIDATION", "")),
        ("txtSearch", ""),
        ("cboGeography", "All"),
        ("cboYear", str(year)),
        ("cboPeriod", period),
        ("chkDownloadZip", "on"),
        ("btnDownload", "Download"),
    ]
    payload += [(f, "on") for f in fields]
    return payload


def _served_filename(response: httpx.Response, fallback: str) -> str:
    m = re.search(r'filename="?([^";]+)', response.headers.get("Content-Disposition", ""))
    return m.group(1).strip() if m else fallback


class BtsFetcher:
    """Drives the DL_SelectFields form. Inject a client to test without a network."""

    def __init__(self, client: httpx.Client | None = None, timeout: float = 600.0):
        self._client = client or httpx.Client(
            timeout=timeout, headers={"User-Agent": USER_AGENT}, follow_redirects=True
        )

    def download_year(
        self, table: Table, year: int, retries: int = 3, backoff: float = 5.0
    ) -> tuple[bytes, str]:
        """Return `(zip_bytes, served_filename)` for one year.

        Re-GETs the form on every attempt: cookies and viewstate must come from the same
        request, so a retry cannot reuse a stale one.
        """
        last_error: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                form = self._client.get(table.url)
                form.raise_for_status()
                hidden = parse_hidden_fields(form.text)
                fields = parse_data_fields(form.text)

                # Encode by hand: httpx's `data=` takes a mapping, but the payload is an
                # ordered sequence of pairs and BTS is sensitive to field ordering.
                response = self._client.post(
                    table.url,
                    content=urlencode(build_download_payload(hidden, fields, year)),
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                response.raise_for_status()
                body = response.content

                if body[:2] != b"PK":
                    raise NotAZipError(
                        f"{table.slug} {year}: expected a zip, got "
                        f"{response.headers.get('Content-Type', '?')} ({len(body)} bytes)"
                    )
                if len(body) < MIN_ZIP_BYTES:
                    raise ShortResponseError(
                        f"{table.slug} {year}: zip is {len(body)} bytes, "
                        f"under the {MIN_ZIP_BYTES}-byte floor — treating as truncated"
                    )
                return body, _served_filename(response, f"{table.slug}_{year}.zip")

            except (httpx.HTTPStatusError, httpx.TransportError) as exc:
                last_error = exc
                if attempt < retries and backoff:
                    time.sleep(backoff * attempt)
        raise last_error  # type: ignore[misc]


def plan_years(
    start: int | None = None, end: int | None = None, today: dt.date | None = None
) -> list[int]:
    """The years to fetch, inclusive. Defaults to the whole window through the current year."""
    start = WINDOW_START if start is None else start
    end = (today or dt.date.today()).year if end is None else end
    if start < WINDOW_START:
        raise ValueError(f"window starts at {WINDOW_START}; got {start}")
    if end < start:
        raise ValueError(f"end {end} is not after start {start}")
    return list(range(start, end + 1))


def raw_path(raw_dir: Path, table: Table, year: int | None, download_date: str) -> Path:
    """Where one download lands: `{slug}[_{year}]_{YYYYMMDD}.zip`.

    The date is in the filename because **`data/raw/` is append-only** — BTS silently amends
    filings, and a re-fetch must not destroy the download that produced the numbers already
    published. Without a date here there is nowhere to keep the previous one.

    Never the BTS-served filename: that is regenerated per request, so it would re-download
    every year forever.
    """
    stamp = download_date.replace("-", "")
    parts = [table.slug, str(year), stamp] if year is not None else [table.slug, stamp]
    return Path(raw_dir) / f"{'_'.join(parts)}.zip"


def find_raw(raw_dir: Path, table: Table, year: int | None = None) -> list[Path]:
    """Every download for this (table, year), oldest first."""
    prefix = f"{table.slug}_{year}_" if year is not None else f"{table.slug}_"
    found = [
        p
        for p in Path(raw_dir).glob(f"{prefix}*.zip")
        if p.stem.rsplit("_", 1)[-1].isdigit() and len(p.stem.rsplit("_", 1)[-1]) == 8
    ]
    return sorted(found, key=lambda p: p.stem.rsplit("_", 1)[-1])


def latest_raw(raw_dir: Path, table: Table, year: int | None = None) -> Path | None:
    """The newest download for this (table, year), or None. This is what feeds a mart —
    older ones are audit-only and are never read."""
    found = find_raw(raw_dir, table, year)
    return found[-1] if found else None


def data_csv_digest(source: Path | bytes) -> str:
    """sha256 of the single DATA CSV inside a BTS zip. Accepts a path or a downloaded body.

    Digests the extracted member, never the zip, and that is the whole point. Measured on two
    consecutive real downloads of `aircraft_types`: identical member CRCs (`c78623da`) and
    identical sizes, but entry mtimes of `2026-08-08 01:18:58` and `22:18:04` — so the zips
    differ byte-for-byte while the data is unchanged. A zip-level hash reports every re-download
    as new, forever, which is why this is not `sha256(body)`.

    `Documentation.csv` is excluded along with it: it ships in every BTS zip and a docs-only
    edit would otherwise read as a data change.
    """
    handle = io.BytesIO(source) if isinstance(source, bytes) else source
    try:
        with zipfile.ZipFile(handle) as z:
            members = [
                n
                for n in z.namelist()
                if n.lower().endswith(".csv") and "documentation" not in n.lower()
            ]
            if len(members) != 1:
                raise NotAZipError(f"expected 1 data CSV in the zip, found {members}")
            digest = hashlib.sha256()
            with z.open(members[0]) as f:
                # Chunked: the 2025 extract is ~14 MB compressed and far larger open.
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    digest.update(chunk)
    except zipfile.BadZipFile as exc:
        raise NotAZipError(f"not a readable zip: {exc}") from exc
    return digest.hexdigest()


def _unchanged(body: bytes, existing: Path | None) -> bool:
    """True when `body` carries the same data CSV as the download already on disk.

    A re-fetch that changes nothing must not append a file. `data/raw/` is append-only and
    `make ingest` forces the current year, the previous year and all three support tables on
    every run — measured on the real tree after two consecutive publisher days, ALL FIVE of the
    second day's downloads were content-identical to the first day's: 20.3 MB of 162.4 MB,
    in one day. Skipping the WRITE keeps the append-only rule intact rather than bending it;
    nothing is overwritten and nothing is deleted, and the file that produced published numbers
    stays exactly where it is.

    An existing file that cannot be read is treated as "no comparison available" — write the
    new one. A truncated zip already on disk must not make every future ingest fail, and
    writing is the safe direction. A malformed NEW body still raises, out of `data_csv_digest`.
    """
    if existing is None:
        return False
    # The NEW body is digested outside the guard on purpose. `download_year` only checks the
    # `PK` magic and a minimum size, so a truncated response reaches here; letting it raise
    # fails that year loudly (main collects and reports) instead of writing a corrupt zip into
    # the append-only tree. Only the EXISTING file's unreadability is tolerated.
    fresh = data_csv_digest(body)
    try:
        return fresh == data_csv_digest(existing)
    except (NotAZipError, OSError):
        return False


def fetch_year(
    fetcher: BtsFetcher, table: Table, year: int, raw_dir: Path, *, force: bool = False
) -> Path:
    """Download one year into `raw_dir` unless already cached. Returns the zip path.

    Writes a `.json` sidecar carrying `download_date`, which drives amended-filing
    resolution — see docs/data/invariants.md.
    """
    existing = latest_raw(raw_dir, table, year)
    if existing and not force:
        return existing

    body, served = fetcher.download_year(table, year)
    if _unchanged(body, existing):
        return existing

    download_date = dt.date.today().isoformat()
    path = raw_path(raw_dir, table, year, download_date)

    # Only touch the filesystem once the response has been validated, so a failure can't
    # poison the cache and make the next run skip a year it never actually got.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    path.with_suffix(".json").write_text(
        json.dumps(
            {
                "table_id": table.table_id,
                "slug": table.slug,
                "year": year,
                "served_filename": served,
                "download_date": download_date,
                "bytes": len(body),
            },
            indent=2,
        )
        + "\n"
    )
    return path


def main(argv: list[str] | None = None) -> int:
    """`make ingest` entry point. Fetches the window into data/raw/, skipping cached years."""
    import argparse
    import logging

    parser = argparse.ArgumentParser(description="Fetch BTS T-100 Domestic Segment zips.")
    parser.add_argument("--start", type=int, default=None, help=f"first year (>= {WINDOW_START})")
    parser.add_argument("--end", type=int, default=None, help="last year (default: this year)")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--force", action="store_true", help="re-download cached years")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    log = logging.getLogger("fetch")

    years = plan_years(args.start, args.end)
    fetcher = BtsFetcher()
    failures: list[tuple[int, Exception]] = []

    for year in years:
        existing = latest_raw(args.raw_dir, T100D_SEGMENT_US, year)
        if existing and not args.force:
            log.info("%s  cached (%s)", year, existing.name)
            continue
        try:
            log.info("%s  fetching...", year)
            written = fetch_year(fetcher, T100D_SEGMENT_US, year, args.raw_dir, force=args.force)
            if written == existing:
                # Downloaded and discarded: BTS served the same data. Say so, or the line
                # reads as a fresh write of a file dated days earlier.
                log.info("%s  unchanged (%s kept)", year, written.name)
            else:
                log.info("%s  %s (%s bytes)", year, written.name, f"{written.stat().st_size:,}")
        except Exception as exc:  # noqa: BLE001 — report every year, fail at the end
            log.error("%s  FAILED: %s", year, exc)
            failures.append((year, exc))

    if failures:
        # Loud, non-zero, and names every gap: a partial ingest must never look like success.
        log.error("%d of %d years failed: %s", len(failures), len(years), [y for y, _ in failures])
        return 1
    log.info("ok — %d years in %s", len(years), args.raw_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
