"""The marts ship with the code, and this file is what keeps them there.

`mart_route_health` and the other nine database objects are a pure function of `data/parquet`
plus `sql/02_marts/` -- `pipeline.marts.build_database` reads the existing `upgauge.duckdb` not
at all. But the published release asset carries a COPY of that database, frozen at publish time,
and `warehouse.yml` republishes only when BTS advances a month. So for as long as the asset's
copy was what CI restored and what the container served, a change to `sql/02_marts/` could not
reach either: measured, `sql/`'s mart SQL plus one new column raised `BinderException:
Referenced column "t12_months_flown" not found in FROM clause!` against `warehouse-2026.05`.

Two rebuilds close that -- one in `.github/actions/setup` (every CI job) and one in the
Dockerfile's `warehouse` BUILDER stage (the image). Both are invisible when removed: CI stays
green against a mart no commit here produced, and the container serves one. Nothing else asserts
either, which is why they are asserted here.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import yaml

REPO = Path(__file__).parents[2]
SETUP_ACTION = REPO / ".github" / "actions" / "setup" / "action.yml"
DOCKERFILE = REPO / "Dockerfile"
MISE = REPO / "mise.toml"


# --------------------------------------------------------------------------------------
# the CI half -- .github/actions/setup
# --------------------------------------------------------------------------------------


def _setup_steps() -> list[dict]:
    return yaml.safe_load(SETUP_ACTION.read_text())["runs"]["steps"]


def _index_of_step_running(steps: list[dict], needle: str) -> int | None:
    for i, step in enumerate(steps):
        run = step.get("run")
        if isinstance(run, str) and needle in run:
            return i
    return None


def test_the_setup_action_rebuilds_the_marts():
    """THE assertion for the CI half. Delete that step and every gate in this repository goes
    back to testing the marts baked into the published asset -- with nothing red anywhere,
    because the asset's database opens fine and answers every query the old SQL asked. That is
    the defect, and it is the one no other test in this repo can see."""
    steps = _setup_steps()
    at = _index_of_step_running(steps, "make build")
    assert at is not None, (
        "the setup action no longer runs `make build`, so every job that uses it tests the "
        "marts frozen into the release asset rather than the ones sql/02_marts/ produces"
    )
    # UNCONDITIONAL is half the property, and the half a plausible optimisation removes. An
    # `if: steps.cache.outputs.cache-hit != 'true'` reads as "skip redundant work" and is the
    # exact defect this step's own comment warns about: actions/cache stores the REBUILT
    # database, so on a hit the gates would run against a mart from whichever earlier commit
    # last populated that key -- worse than the baked asset, which at least had one known
    # provenance. Nothing else in this repo can see that; the workflow stays green.
    assert "if" not in steps[at], (
        f"the mart rebuild is conditional ({steps[at]['if']!r}). It must run on every job, "
        f"every time: the restored upgauge.duckdb may itself be a cached rebuild from another "
        f"commit, so skipping the rebuild serves marts of unknown provenance with nothing red"
    )


def test_the_mart_rebuild_runs_after_the_warehouse_restore_is_asserted():
    """The ordering, named separately so a reorder reddens on its own rather than hiding inside
    the presence check above. `make build` reads `data/parquet`, which the restore is what puts
    on disk, and it runs through `uv`, which the dep install is what provides. CI would also
    fail loudly on a pre-restore rebuild; this says which property that failure is about."""
    steps = _setup_steps()
    build_at = _index_of_step_running(steps, "make build")
    assert build_at is not None, "no `make build` step at all -- see the test above"

    assert_at = next(
        (
            i
            for i, s in enumerate(steps)
            if "warehouse is actually present" in (s.get("name") or "")
        ),
        None,
    )
    assert assert_at is not None, "the warehouse-presence assertion step is gone"
    assert build_at > assert_at, (
        "`make build` runs before the warehouse restore is asserted present -- it reads "
        "data/parquet, so it would fail on a cold runner for a reason that names the wrong thing"
    )

    sync_at = _index_of_step_running(steps, "uv sync")
    assert sync_at is not None, "the pipeline dep install is gone"
    assert build_at > sync_at, "`make build` runs before `uv sync`, so uv has nothing to run with"


# --------------------------------------------------------------------------------------
# the CI cache -- a key names exactly what the cached bytes depend on
# --------------------------------------------------------------------------------------
#
# `actions/cache` in the setup action keys on the resolved `warehouse-YYYY.MM` tag. Once the
# mart rebuild above became unconditional, anything the rebuild WRITES that stays inside the
# cached `path:` is saved post-job under that key -- so the key would say `warehouse-2026.05`
# while the bytes are `warehouse-2026.05 + whichever commit last populated the key`. The whole
# `upgauge.duckdb` is such an output: every one of its ten objects is `CREATE OR REPLACE
# VIEW|TABLE ... AS <sql/02_marts/*.sql>` over `data/parquet`, and `build_database` builds a
# staging file and renames over it, so not one byte of that file is a function of the tag.
#
# Narrowing the cache to `data/parquet` -- which IS a pure function of the tag, and IS the
# release-asset download the cache exists to avoid -- restores the invariant. Including the
# commit in the key would restore it too, at the cost of a cache miss on every push; these tests
# state the invariant, not the choice, so either fix passes and the broken pair does not.


def _marts_cli_defaults() -> dict[str, str]:
    """`make build`'s two path defaults, read off `pipeline/marts.py`'s own argparse.

    Derived rather than restated: `--parquet-dir` is what the restore must put on disk and
    `--db` is what the rebuild writes, and the cache tests below are about exactly that split.
    Rename either in `marts.py` and this reddens here rather than quietly testing a path no
    `make build` uses.
    """
    text = (REPO / "pipeline" / "marts.py").read_text()
    out = {}
    for flag in ("--parquet-dir", "--db"):
        m = re.search(rf'"{flag}",[^)]*default=Path\("([^"]+)"\)', text)
        assert m is not None, f"pipeline/marts.py no longer declares a default for {flag}"
        out[flag] = m.group(1)
    return out


def _cache_step() -> dict:
    step = next(
        (s for s in _setup_steps() if str(s.get("uses", "")).startswith("actions/cache")), None
    )
    assert step is not None, (
        "the setup action no longer caches the warehouse at all. Do not close the cache-key "
        "issue by deleting the cache: avoiding the release-asset download on every job is what "
        "the cache is for, and that download is the expensive part"
    )
    return step["with"]


def _cached_paths() -> list[str]:
    return [p.strip().rstrip("/") for p in _cache_step()["path"].splitlines() if p.strip()]


#: Contexts that make a cache key commit-specific. `github.sha` is the one this repo would
#: reach for (image.yml already keys its image tag `<warehouse-tag>-<sha>`); the PR head sha is
#: the same claim spelled for `pull_request`, where `github.sha` is the merge commit.
_COMMIT_CONTEXTS = ("github.sha", "github.event.pull_request.head.sha")


def _key_names_the_commit(key: str) -> bool:
    return any(ctx in key for ctx in _COMMIT_CONTEXTS)


def test_the_commit_contexts_tell_a_tag_only_key_from_a_commit_specific_one():
    """DISCRIMINATION for the predicate the cache test below leans on. Written as its own test
    because a predicate that answers True for everything makes that test unable to fail, and a
    predicate that answers False for everything makes it unable to accept the OTHER legitimate
    fix -- neither is visible from the call site, which passes either way against the real file
    (the real key names no commit AND caches no build output)."""
    tag_only = "warehouse-${{ inputs.warehouse-tag }}"
    assert not _key_names_the_commit(tag_only), (
        f"{tag_only!r} names only the asset tag, so bytes that depend on the commit cannot be "
        f"stored under it -- a predicate that calls this commit-specific disables the cache test"
    )
    for spelling in (
        "warehouse-${{ inputs.warehouse-tag }}-${{ github.sha }}",
        "warehouse-${{ inputs.warehouse-tag }}-${{ github.event.pull_request.head.sha }}",
    ):
        assert _key_names_the_commit(spelling), (
            f"{spelling!r} names the commit, so it may legitimately carry commit-derived bytes; "
            f"a predicate that refuses it makes the second of the two valid fixes unreachable"
        )


def test_the_warehouse_cache_still_holds_the_parquet_tree():
    """The half that keeps the cache worth having. `data/parquet` is a pure function of the
    warehouse tag -- it is the facts and the dims, unpacked verbatim from the release asset --
    and it is the download the cache exists to avoid. Dropping it is how a key/content mismatch
    gets "fixed" for free, and #160 rules that out in as many words."""
    parquet_dir = _marts_cli_defaults()["--parquet-dir"]
    assert parquet_dir in _cached_paths(), (
        f"the setup action no longer caches {parquet_dir!r}, so every job re-downloads the "
        f"release asset. That is not the fix for a key that overpromises; narrowing what is "
        f"cached, or naming the commit in the key, is"
    )


def test_the_warehouse_cache_key_names_everything_the_cached_bytes_depend_on():
    """THE assertion for #160. `make build` writes `upgauge.duckdb` from `data/parquet` plus
    THIS COMMIT's `sql/02_marts/`, so caching that file under a key naming only the asset tag
    stores commit-derived bytes under a tag-derived name: a later run on a different commit
    restores a mart no commit in its own tree produced. Benign only while the rebuild is
    unconditional -- and `test_the_setup_action_rebuilds_the_marts` above is the only thing
    holding that, which is precisely why the cache must not also be relying on it.

    Stated as the invariant rather than as this repo's choice of fix: a key that names the
    commit may carry the database, and a key that names only the tag may not."""
    key = str(_cache_step()["key"])
    db = _marts_cli_defaults()["--db"]
    if _key_names_the_commit(key):
        return
    assert db not in _cached_paths(), (
        f"the warehouse cache stores {db!r} under key {key!r}, which names only the release "
        f"tag. {db!r} is `make build`'s own output -- every object in it comes from this "
        f"commit's sql/02_marts/ -- so the post-job save writes this commit's marts under a "
        f"key that promises the asset's. Either drop it from `path:` (it costs ~1 s to "
        f"rebuild, and the rebuild runs unconditionally anyway) or put the commit in `key:`"
    )


def test_the_asset_is_unpacked_without_its_publish_day_database():
    """The same invariant on the cache-MISS path. The release tarball carries `upgauge.duckdb`
    beside `data/parquet`, and that copy is whatever `sql/02_marts/` looked like on publish day.
    Extracting only `data/parquet` means no publish-day mart bytes exist in a CI job at all, on
    either path -- so deleting the rebuild stops being a silent wrong answer and becomes a
    missing database, which every gate names."""
    step = next((s for s in _setup_steps() if "warehouse-*.tar.zst" in str(s.get("run", ""))), None)
    assert step is not None, "the setup action no longer downloads the warehouse asset"
    parquet_dir = _marts_cli_defaults()["--parquet-dir"]
    # Bash comment lines dropped first. The step's own comment explains the extraction, and a
    # needle that matches PROSE is this repo's most-repeated test defect -- test_live_check.py's
    # `_uncommented` exists because one resolved `/api/health` to a character inside a comment.
    body = [ln for ln in step["run"].splitlines() if not ln.strip().startswith("#")]
    extract = next(ln for ln in body if "tar --zstd -xf" in ln)
    assert extract.split()[-1] == parquet_dir, (
        f"the asset extraction is {extract.strip()!r}, which unpacks the tarball's own "
        f"`upgauge.duckdb` -- the marts frozen at publish time. Name {parquet_dir!r} as the "
        f"member to extract so the only database a CI job can ever have is the rebuilt one"
    )


def test_the_rebuilt_database_is_asserted_present():
    """The anti-vacuity guard for the rebuild's own output. Nothing restores `upgauge.duckdb`
    any more, so if `make build` ever exits 0 without writing one, the suite reports a green run
    full of "no built catalog" skips -- which is the shape the presence assert for the Parquet
    tree already exists to refuse."""
    db = _marts_cli_defaults()["--db"]
    runs = [str(s.get("run", "")) for s in _setup_steps()]
    assert any(f"-f {db}" in r for r in runs), (
        f"nothing in the setup action checks that {db!r} exists. The restore no longer "
        f"provides it, so this is the only check that `make build` produced anything"
    )


def test_the_database_presence_assert_runs_after_the_mart_rebuild():
    """Ordering, on its own, because the two properties fail for different reasons and a
    reviewer needs to be told which. Before `make build` this check is not merely redundant --
    it is RED on every cache hit, since the restore stops putting a database on disk."""
    steps = _setup_steps()
    db = _marts_cli_defaults()["--db"]
    build_at = _index_of_step_running(steps, "make build")
    assert build_at is not None, "no `make build` step at all -- see the tests above"
    check_at = _index_of_step_running(steps, f"-f {db}")
    assert check_at is not None, f"nothing checks {db!r} exists -- see the test above"
    assert check_at > build_at, (
        f"the {db!r} presence check runs at step {check_at}, before the rebuild at "
        f"{build_at}. Nothing restores that file any more, so the check would fail every job "
        f"for a reason that names the restore rather than the rebuild"
    )


# --------------------------------------------------------------------------------------
# the image half -- the Dockerfile's stage boundaries
# --------------------------------------------------------------------------------------


def _stages(text: str | None = None) -> dict[str, list[str]]:
    """Dockerfile instructions grouped by stage name, comments and blank lines dropped.

    Continuations are joined, so a multi-line `RUN ... \\` is one entry. Instructions before the
    first `FROM` (the global ARGs) land under the empty-string key.
    """
    text = DOCKERFILE.read_text() if text is None else text
    joined: list[str] = []
    buffer = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        buffer = f"{buffer} {line}" if buffer else line
        if buffer.endswith("\\"):
            buffer = buffer[:-1].rstrip()
            continue
        joined.append(buffer)
        buffer = ""
    if buffer:
        joined.append(buffer)

    out: dict[str, list[str]] = {"": []}
    current = ""
    for instruction in joined:
        m = re.match(r"^FROM\s+\S+\s+AS\s+(\S+)\s*$", instruction, re.IGNORECASE)
        if m:
            current = m.group(1)
            out[current] = []
            continue
        out[current].append(instruction)
    return out


def test_the_image_rebuilds_the_marts_in_the_warehouse_stage():
    """THE assertion for the image half. Without it the container serves the asset's frozen
    marts, and the shape that failure takes is the worst this repo names: every
    `/watch/<preset>` 500s under `HTML_CACHE` (public, s-maxage=3600) because the proxy commits
    the header before the page runs, while `/api/health` keeps reporting **ok** -- health_catalog
    .sql asks `mart_route_health` for only `op_airline_id` and `health_score`."""
    stages = _stages()
    assert "warehouse" in stages, "the Dockerfile no longer has a `warehouse` stage"
    assert any(i.startswith("RUN") and "make build" in i for i in stages["warehouse"]), (
        "the warehouse stage no longer rebuilds the marts, so the image ships whatever "
        "sql/02_marts/ looked like on the day the release asset was published"
    )


def test_the_image_rebuilds_the_marts_after_unpacking_the_asset():
    """Ordering, on its own, for the same reason the CI ordering test is its own test: the
    rebuild reads `data/parquet`, which the extraction is what produces."""
    steps = _stages()["warehouse"]
    extract_at = next((i for i, s in enumerate(steps) if "tar --zstd -xf" in s), None)
    build_at = next(
        (i for i, s in enumerate(steps) if s.startswith("RUN") and "make build" in s), None
    )
    assert extract_at is not None, "the warehouse stage no longer unpacks the release asset"
    assert build_at is not None, "no mart rebuild at all -- see the test above"
    assert build_at > extract_at, (
        "the mart rebuild runs before the asset is unpacked, so data/parquet does not exist yet"
    )


# WHAT THE RUNTIME STAGE MAY TAKE OUT OF A BUILDER, as an allow-list keyed on the source stage.
# A blacklist of forbidden sources cannot hold this boundary, and the measurement is the reason:
# `COPY --from=warehouse /w/pipeline ./pipeline` is the form the runtime stage ALREADY uses twice
# for the database and the Parquet tree, so it is the most natural way anyone would break the
# rule -- and a blacklist that normalises `./pipeline` to `pipeline` never sees `/w/pipeline` at
# all. The same blacklist was blind to `/opt/venv` (which ships CPython AND duckdb) and to
# `/usr/local/bin/uv`. Naming what MAY cross is the only form that refuses everything else,
# including the next builder path nobody has thought of yet.
_RUNTIME_COPY_ALLOW = {
    "build": {"/build/app/.next"},
    "warehouse": {"/w/upgauge.duckdb", "/w/data/parquet"},
}

# Paths that exist only because the warehouse stage built them. None may be NAMED anywhere in
# the runtime stage -- not as a COPY source, not on a PATH, not inside a RUN. `ENV
# PATH=/opt/venv/bin:$PATH` copies nothing and runs nothing, so neither of the other two checks
# can see it, and it is enough to make the interpreter reachable if anything ever lands there.
_BUILDER_ONLY_PATHS = (
    "/opt/venv",
    "/usr/local/bin/uv",
    "/w/pipeline",
    "/w/sql",
    "/w/Makefile",
    "/w/pyproject.toml",
    "/w/uv.lock",
)

# Context (non `--from`) COPY sources that are CI-only. Compared on a NORMALISED path, so
# `./pipeline`, `pipeline/` and `pipeline` are one thing.
_CI_ONLY_SOURCES = {"pipeline", "pyproject.toml", "uv.lock"}

_PY_APT = re.compile(r"\b(python3?|python3-pip|pip3?)\b")
# Path-aware on purpose: a bare-word rule reads `/opt/venv/bin/python -m pipeline.marts` as
# nothing at all, because the interpreter is not preceded by a space or a `&&`.
_PY_RUNNERS = re.compile(r"(?:^|\s|&&\s*|\|\s*|;\s*)(?:\S*/)?(uv|uvx|python3?|pip3?|make)\b")


def _copy_sources(instruction: str) -> tuple[str | None, list[str]]:
    """`(from_stage, sources)` for a COPY/ADD. The last argument is the destination."""
    from_stage = None
    args = []
    for token in instruction.split()[1:]:
        if token.startswith("--from="):
            from_stage = token.split("=", 1)[1]
        elif not token.startswith("--"):
            args.append(token)
    return from_stage, args[:-1]


def _normalise(src: str) -> str:
    """`./pipeline`, `pipeline/` and `pipeline` are one source. Absolute paths keep their root,
    because that is what distinguishes a builder path from a context path."""
    src = src.rstrip("/")
    return src[2:] if src.startswith("./") else src


def test_the_runtime_stage_copies_only_what_the_allow_list_names():
    """THE boundary, stated the way the docs state it: `runtime` takes `upgauge.duckdb` and
    `data/parquet` out of `warehouse` and nothing else.

    Asserted as an ALLOW-LIST because a blacklist demonstrably cannot hold it. Measured: six
    separate ways of putting the Python toolchain into the shipped image passed a blacklist form
    of this test, and the worst of them -- `COPY --from=warehouse /w/pipeline ./pipeline` --
    is spelled exactly like the two COPYs the stage already has. An allow-list also fails safe
    for the next builder path nobody has thought of, which is the property that matters after
    this file stops being read."""
    for instruction in _stages()["runtime"]:
        if not instruction.startswith(("COPY", "ADD")):
            continue
        from_stage, sources = _copy_sources(instruction)
        if from_stage is None:
            continue
        assert from_stage in _RUNTIME_COPY_ALLOW, (
            f"the runtime stage copies from the {from_stage!r} stage, which nothing has "
            f"authorised it to take anything from: {instruction!r}"
        )
        allowed = _RUNTIME_COPY_ALLOW[from_stage]
        for src in sources:
            assert _normalise(src) in allowed, (
                f"the runtime stage copies {src!r} out of {from_stage!r}. Only "
                f"{sorted(allowed)} may cross that boundary -- everything else in a builder is "
                f"build-time apparatus, and pipeline/ and its interpreter are CI-only, never "
                f"prod: {instruction!r}"
            )


def test_no_python_toolchain_reaches_the_runtime_stage():
    """CLAUDE.md: `pipeline/` is "Python 3.12 + uv. CI only, never runs in prod." The warehouse
    stage is a BUILDER and is discarded, so it may hold all of this; `runtime` is what ships.

    The allow-list above closes the cross-stage route. This closes the other three, each with
    its own assertion so a mutant names the clause that refused it: a CONTEXT copy of `pipeline/`
    or the lock files, an apt-installed interpreter, and any instruction that so much as NAMES a
    builder-only path -- which is what catches `ENV PATH=/opt/venv/bin:$PATH`, an instruction
    that neither copies nor runs anything."""
    for instruction in _stages()["runtime"]:
        for path in _BUILDER_ONLY_PATHS:
            assert path not in instruction, (
                f"the runtime stage names the builder-only path {path!r}, which exists only "
                f"because the warehouse stage built it: {instruction!r}"
            )

        if instruction.startswith(("COPY", "ADD")):
            from_stage, sources = _copy_sources(instruction)
            if from_stage is None:
                for src in sources:
                    assert _normalise(src) not in _CI_ONLY_SOURCES, (
                        f"the runtime stage copies {src!r} out of the build context -- "
                        f"pipeline/ and its lock files are CI-only, never prod: {instruction!r}"
                    )

        if instruction.startswith("RUN"):
            body = instruction[len("RUN") :]
            if "apt-get install" in body:
                assert not _PY_APT.search(body), (
                    f"the runtime stage apt-installs a Python interpreter: {instruction!r}"
                )
            m = _PY_RUNNERS.search(body)
            assert m is None, (
                f"the runtime stage runs {m.group(1)!r}, which belongs to a builder: "
                f"{instruction!r}"
            )


def test_the_runtime_check_is_scoped_to_the_runtime_stage_and_not_the_whole_file():
    """DISCRIMINATION, and this is the property that actually matters. Every path and token the
    two tests above refuse is TRUE of the warehouse stage on purpose -- it copies `pipeline`,
    copies the lock files, copies the uv binary, builds `/opt/venv` and runs `uv` and `make`. So
    either test written as a grep over the whole Dockerfile is RED against the correct file, and
    would then be "fixed" by weakening it into something that passes for any input. Measured:
    re-scoping the runtime check to every stage fails on the warehouse stage's own apt line.

    This asserts the two halves separately: the runtime stage carries none of it, and the
    warehouse stage carries all of it. Deleting the mart rebuild reddens the second half here as
    well as the two tests above -- which is correct; it is the same defect seen from the side
    that says the toolchain is supposed to exist SOMEWHERE."""
    stages = _stages()
    warehouse = " ; ".join(stages["warehouse"])
    runtime = " ; ".join(stages["runtime"])

    for token in ("COPY pipeline", "--from=uvbin", "uv sync", "make build", "/opt/venv"):
        assert token in warehouse, (
            f"the warehouse builder no longer carries {token!r} -- if the toolchain moved, this "
            f"test and the runtime check are asserting a boundary that has stopped existing"
        )
        assert token not in runtime, f"{token!r} reached the runtime stage"


# --------------------------------------------------------------------------------------
# the pins -- one statement of a version per runtime, wherever it is written
# --------------------------------------------------------------------------------------


def _mise_tools() -> dict[str, str]:
    body = MISE.read_text().split("[tools]", 1)[1].split("\n[", 1)[0]
    out = {}
    for line in body.splitlines():
        m = re.match(r'^\s*([a-z0-9_]+)\s*=\s*"([^"]+)"', line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def _dockerfile_args() -> dict[str, str]:
    return {
        m.group(1): m.group(2)
        for m in re.finditer(r"^ARG\s+([A-Z_]+)=(\S+)\s*$", DOCKERFILE.read_text(), re.MULTILINE)
    }


def test_the_images_toolchain_pins_equal_mise_tomls():
    """`mise.toml` says every runtime is pinned EXACTLY because "a floating 3.12 would silently
    move to 3.12.13 and quietly invalidate" the reproducibility proof. The Dockerfile restates
    three of those pins, and until now nothing checked any of them -- the Dockerfile's own
    comment ("Keep this version equal to mise.toml's node") and image-contract.yml's `mise.toml`
    path entry ("the node pin the Dockerfile's NODE_VERSION must equal") both asserted the
    equality in prose only.

    It is not cosmetic on the two new ones: UV_VERSION and PYTHON_VERSION decide which uv
    resolves `uv.lock` and which interpreter runs `pipeline.marts` inside the image, so a drift
    there means the container's marts were built by a toolchain no gate in this repo ran."""
    args = _dockerfile_args()
    tools = _mise_tools()
    for arg, tool in (("NODE_VERSION", "node"), ("PYTHON_VERSION", "python"), ("UV_VERSION", "uv")):
        assert arg in args, f"the Dockerfile no longer declares ARG {arg}"
        assert tool in tools, f"mise.toml no longer pins {tool}"
        assert args[arg] == tools[tool], (
            f"Dockerfile ARG {arg}={args[arg]} but mise.toml pins {tool}={tools[tool]} -- the "
            f"image would build against a runtime no gate in this repo ran under"
        )


# --------------------------------------------------------------------------------------
# the ARTIFACT half -- what the BUILT image contains, not what the Dockerfile says (#162)
# --------------------------------------------------------------------------------------
#
# Everything above is INSTRUCTION-level. It proves no instruction in the Dockerfile introduces
# an interpreter. It cannot prove the IMAGE lacks one: `node:*-slim` starting to ship `python3`,
# or an apt dependency pulling one in transitively, satisfies every assertion in this file while
# putting an interpreter in production.
#
# Only the running container can answer that, so the assertion itself is a check in
# `app/smoke.sh`'s container mode, executed by `make image-smoke`. What is asserted HERE is that
# it still exists, still looks for everything the instruction-level allow-list refuses, and is
# still RED when it cannot run -- none of which any other gate can see. Deleting a smoke check
# leaves `make check`, `make app-check` and `make app-smoke` green and merely reports a smaller
# number that nothing compares against.

SMOKE = REPO / "app" / "smoke.sh"

# The probe is a single-quoted assignment rather than an inline `sh -c '...'`, which is what
# makes it extractable and therefore EXECUTABLE from a test -- see
# test_the_probe_reports_clean_only_when_it_finds_nothing, which runs this exact program against
# planted artifacts instead of reading it. The call site is asserted separately, because a pinned
# program is not a pinned call site.
_PROBE_RE = re.compile(r"^TOOLCHAIN_PROBE='\n(.*?)\n'$", re.DOTALL | re.MULTILINE)

# The probe's two loops, read as TOKEN SETS rather than as substrings of the whole body. Measured
# on the substring form this replaced: dropping `uv` from the PATH scan entirely left the name
# check GREEN, because `uv.lock` two lines below still contains the string "uv".
_PATH_LOOP = re.compile(r"^for b in (.+); do$", re.MULTILINE)
_FILE_LOOP = re.compile(r"^for p in (.+); do$", re.MULTILINE)

# The anchored equality the check asserts, READ FROM smoke.sh rather than restated here -- a
# hand-copied pattern is green against a weakened one, which is the failure both halves of this
# section exist to refuse. The probe prints `scanned:` unconditionally as its LAST act, so "found
# nothing" and "never ran" are different strings rather than the same empty one.
_SENTINEL_RE = re.compile(r"^TOOLCHAIN_CLEAN='(.*)'$", re.MULTILINE)


def _probe_sentinel() -> str:
    found = _SENTINEL_RE.search(SMOKE.read_text())
    assert found is not None, (
        "app/smoke.sh no longer defines TOOLCHAIN_CLEAN, the pattern the artifact-level check "
        "asserts the probe's output against (#162)"
    )
    return found.group(1)


def _probe_body() -> str:
    found = _PROBE_RE.search(SMOKE.read_text())
    assert found is not None, (
        "app/smoke.sh no longer defines TOOLCHAIN_PROBE, so nothing asserts that the RUNNING "
        "runtime image is free of the Python toolchain -- only that no Dockerfile instruction "
        "puts it there, which a base image or a transitive apt dependency does not need (#162)"
    )
    return found.group(1)


def _probe_names() -> tuple[set[str], set[str]]:
    """`(resolved on PATH, tested on the filesystem)`, as the sets the probe actually loops over."""
    body = _probe_body()
    on_path = _PATH_LOOP.search(body)
    on_disk = _FILE_LOOP.search(body)
    assert on_path and on_disk, (
        f"the probe no longer has both a PATH loop and a filesystem loop, so it cannot be "
        f"asserted to cover either kind of artifact:\n{body}"
    )
    return set(on_path.group(1).split()), set(on_disk.group(1).split())


def _run_probe(cwd: Path, path_dir: Path) -> str:
    """The probe, executed. `sh`, not bash: in the gate it runs under `docker exec ... sh -c`
    against node:*-slim, whose /bin/sh is dash."""
    return subprocess.run(
        ["/bin/sh", "-c", _probe_body()],
        cwd=cwd,
        env={"PATH": str(path_dir)},
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def test_the_running_image_is_probed_and_not_only_the_dockerfile():
    """THE artifact-level assertion, and the whole of #162. Remove it and every gate in this
    repository stays green while the image is free to acquire an interpreter from its base.

    Two properties beyond existence, each of which fails on its own. It runs INSIDE the
    container under test (`docker exec`, not host-side: this checkout holds python3, uv and
    pipeline/ by design, so a host-side form is red against a correct tree and would then be
    "fixed" into something that passes for any input). And the result is asserted as the
    anchored sentinel, not as the absence of a needle."""
    smoke = SMOKE.read_text()
    _probe_body()

    assert 'docker exec upgauge-smoke sh -c "$TOOLCHAIN_PROBE"' in smoke, (
        "the toolchain probe is no longer run inside the container under test. Against the host "
        "it says nothing about the image -- and is red on a correct tree, which invites a "
        "weakening rather than a fix"
    )
    assert "check_re" in smoke and '"$TOOLCHAIN_CLEAN"' in smoke, (
        "the probe's result is no longer asserted with `check_re` against `$TOOLCHAIN_CLEAN`. "
        "Written as an absence test, or with an unanchored pattern, the assertion passes for an "
        "EMPTY haystack -- exactly what a failed `docker exec` produces: a gate that certifies "
        "an image it never read"
    )
    assert _probe_sentinel() == "^scanned: none$", (
        f"the sentinel pattern is now {_probe_sentinel()!r}. Both anchors are load-bearing: "
        f"without `^` and `$` the pattern matches `scanned: none-of-your-business` and, more to "
        f"the point, any line of a multi-line body that happens to contain it"
    )


def test_the_probe_looks_for_every_artifact_the_instruction_guard_refuses():
    """The two halves of one rule must refuse the same set, or the artifact half silently
    narrows. Bound to `_CI_ONLY_SOURCES` rather than to a second hand-written list: add a CI-only
    source up there and this reddens until the probe names it too.

    `/opt/venv` is named explicitly because PATH cannot see it -- it is the warehouse stage's
    `UV_PROJECT_ENVIRONMENT` and carries CPython *and* duckdb, and
    `COPY --from=warehouse /opt/venv /opt/venv` puts all of it in the image while adding nothing
    to PATH. It is one of the six mutants the blacklist form of the instruction guard passed.

    Membership in the loops' own token sets, never `name in body`: measured, the substring form
    stayed GREEN after `uv` was dropped from the PATH scan entirely, because `uv.lock` two lines
    below still spells it."""
    on_path, on_disk = _probe_names()
    for source in sorted(_CI_ONLY_SOURCES):
        assert source in on_disk, (
            f"the instruction guard refuses {source!r} as a runtime COPY source, but the "
            f"artifact probe does not look for it in the built image -- the two halves of the "
            f"same rule now disagree about what 'no Python in prod' means"
        )
    assert "/opt/venv" in on_disk, (
        "the probe no longer looks for /opt/venv, the one artifact PATH cannot see: it carries "
        "CPython AND duckdb, and copying it whole adds nothing to PATH"
    )
    for exe in ("python3", "python", "uv"):
        assert exe in on_path, (
            f"the probe no longer resolves {exe!r} on the container's PATH, which is how an "
            f"interpreter arrives from a base image or a transitive apt dependency -- the exact "
            f"route the Dockerfile guard cannot see. Nothing goes red when this stops being "
            f"checked; it just stops being checked"
        )


def test_the_probe_reports_clean_only_when_it_finds_nothing(tmp_path):
    """The probe EXECUTED, one planted artifact at a time. A grep over smoke.sh proves the names
    are written down, not that the program looks for them: `[ -e ]` narrowed to `[ -d ]`, a
    `command -v` typo, a `$found` assigned and never printed -- each keeps every name in the file
    and reports `scanned: none` for a dirty image forever.

    ONE artifact per case, never all six at once. A fixture planting everything is satisfied by a
    probe that detects only the first of them, which is this repo's vacuous-fixture failure
    wearing half a disguise.

    `/opt/venv` is the one clause a test cannot plant (absolute, unwritable without root), so the
    baseline accounts for whatever this machine happens to have there. It is covered by the name
    check above and executed for real against the container by `make image-smoke`."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    work = tmp_path / "work"
    work.mkdir()

    baseline = _run_probe(work, bin_dir)
    expected = "scanned: FILE:/opt/venv" if Path("/opt/venv").exists() else "scanned: none"
    assert baseline == expected, (
        f"the probe reports {baseline!r} for an empty directory on an empty PATH, not "
        f"{expected!r}. Every case below reads as a delta from this, so a wrong baseline makes "
        f"all of them meaningless"
    )

    for name, is_dir in (("pipeline", True), ("pyproject.toml", False), ("uv.lock", False)):
        planted = work / name
        planted.mkdir() if is_dir else planted.write_text("")
        out = _run_probe(work, bin_dir)
        assert f"FILE:{name}" in out, (
            f"planted {name!r} in the image root and the probe reported {out!r} -- it does not "
            f"detect {name!r}, so the check stays green against an image that ships it"
        )
        planted.rmdir() if is_dir else planted.unlink()

    for exe in ("python3", "python", "uv"):
        planted = bin_dir / exe
        planted.write_text("#!/bin/sh\n")
        planted.chmod(0o755)
        out = _run_probe(work, bin_dir)
        assert f"PATH:{exe}" in out, (
            f"put an executable {exe!r} on PATH and the probe reported {out!r} -- an image whose "
            f"base started shipping it would pass this gate, which is the entire residual #162 "
            f"exists to close"
        )
        planted.unlink()


def _matches_sentinel(haystack: str) -> bool:
    """`grep -E` on smoke.sh's own pattern, invoked the way `has_re` invokes it."""
    return (
        subprocess.run(
            ["grep", "-E", "--", _probe_sentinel()],
            input=haystack,
            capture_output=True,
            text=True,
        ).returncode
        == 0
    )


def test_a_probe_that_could_not_run_is_red_rather_than_silently_clean():
    """The failure mode this repository's smoke history is made of. `docker exec` failing, the
    container already gone, `sh` unresolvable -- each yields an EMPTY string, and an assertion
    shaped as "the output does not contain python3" prints `ok` for a probe that never executed.

    Executed, not read: the pattern smoke.sh actually uses, run against the exact haystacks a
    broken run produces. The last case is the discriminating one -- a pattern that refuses
    everything would satisfy the first four and could never be green."""
    for haystack, why in (
        ("", "docker exec produced nothing at all"),
        ("Error: No such container: upgauge-smoke", "the container was gone"),
        ("scanned: PATH:python3", "the image ships an interpreter"),
        ("scanned: FILE:pipeline", "the image ships pipeline/"),
    ):
        assert not _matches_sentinel(haystack), (
            f"`{_probe_sentinel()}` matches the output of a run where {why}, so the gate reports "
            f"ok for it"
        )

    assert _matches_sentinel("scanned: none"), (
        f"`{_probe_sentinel()}` does not match a clean probe's own output -- the check could "
        f"never be green, and would be deleted as broken rather than read as a finding"
    )
