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
    assert _index_of_step_running(steps, "make build") is not None, (
        "the setup action no longer runs `make build`, so every job that uses it tests the "
        "marts frozen into the release asset rather than the ones sql/02_marts/ produces"
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


# The four things that would make the runtime image carry a Python toolchain. Each is checked
# separately so a mutant names the clause that refused it rather than "something did".
_PY_COPY_SOURCES = ("pipeline", "pyproject.toml", "uv.lock")
_PY_APT = re.compile(r"\b(python3?|python3-pip|pip3?)\b")
_PY_RUNNERS = re.compile(r"(?:^|\s|&&\s*)(uv|uvx|python3?|pip3?|make)\b")


def test_no_python_toolchain_reaches_the_runtime_stage():
    """CLAUDE.md: `pipeline/` is "Python 3.12 + uv. CI only, never runs in prod." The warehouse
    stage is a BUILDER and is discarded, so it may hold all of this; `runtime` is what ships.

    Four independent ways to break it, asserted independently -- a copy of `pipeline/` or of the
    lock files, an apt-installed interpreter, a `COPY --from` of the uv binary, and a RUN that
    invokes any of them. A single "no python anywhere" check would be red against the correct
    Dockerfile, which is the point of the discrimination test below."""
    runtime = _stages()["runtime"]

    for instruction in runtime:
        if instruction.startswith(("COPY", "ADD")):
            assert "--from=uvbin" not in instruction, (
                f"the runtime stage copies the uv binary in: {instruction!r}"
            )
            # Sources are every argument but the flags and the final destination.
            args = [a for a in instruction.split()[1:] if not a.startswith("--")]
            for src in args[:-1]:
                assert src.strip("./") not in _PY_COPY_SOURCES, (
                    f"the runtime stage copies {src!r} into the image -- pipeline/ and its lock "
                    f"files are CI-only, never prod: {instruction!r}"
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
    """DISCRIMINATION, and this is the property that actually matters. Every clause the test
    above applies is TRUE of the warehouse stage on purpose -- it copies `pipeline`, copies the
    lock files, copies the uv binary and runs `uv` and `make`. So a version of that test written
    as a grep over the whole Dockerfile would be red against the correct file, and would then be
    "fixed" by weakening it into something that passes for any input.

    This asserts the two halves separately: the runtime stage carries none of it, and the
    warehouse stage carries all of it. Deleting the mart rebuild reddens the second half here as
    well as the two tests above -- which is correct; it is the same defect seen from the side
    that says the toolchain is supposed to exist SOMEWHERE."""
    stages = _stages()
    warehouse = " ; ".join(stages["warehouse"])
    runtime = " ; ".join(stages["runtime"])

    for token in ("COPY pipeline", "--from=uvbin", "uv sync", "make build"):
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
