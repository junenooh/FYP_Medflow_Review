"""MedFlow batch orchestrator: UC1 → UC2 → UC3.

Ops/Analyst entry point for a repeatable engine run.

Order (affinity first):
  1. UC1 ARM → productrelationship (required upstream)
  2. UC2 replenishment → uses UC1 Strong/Moderate pairs
  3. UC3 layout → uses the same UC1 affinity snapshot

UC4 (digital twin) is not batched here. After a successful UC3 run, open the
planner UI and load that UC3 runid.

Fail-stop: if an upstream stage fails, dependents are not started.

Success → Supabase modelrun (lineage).
Failure / debug → local daily log logs/engine_runs_YYYY-MM-DD.log (kept 14 days).
"""

from __future__ import annotations

import argparse
import traceback

from engines import run_log
from engines.result import StageResult
from engines.shared.db import run_meta
from engines.uc1.arm_jeremiahVer import run as run_uc1
from engines.uc2.replenishment import run as run_uc2
from engines.uc3.layout import run as run_uc3

_STAGE_META = {
    "UC1": {
        "runtype": "UC1",
        "algorithmversion": "uc1-arm-0.1",
        "config_section": "arm",
    },
    "UC2": {
        "runtype": "UC2",
        "algorithmversion": "uc2-replenishment-0.1",
        "config_section": "replenishment",
    },
    "UC3": {
        "runtype": "UC3",
        "algorithmversion": "uc3-layout-0.1",
        "config_section": "warehouse",
    },
}


def _print_result(result: StageResult) -> None:
    line = (
        f"{result.name}: {result.status} "
        f"runid={result.runid or '(none)'} "
        f"in={result.input_rows} out={result.output_rows}"
    )
    print(line)
    if result.error:
        print(f"  error: {result.error}")


def _as_failed(name: str, exc: BaseException, runid: str = "") -> StageResult:
    detail = str(exc).strip() or exc.__class__.__name__
    return StageResult(
        name=name,
        runid=runid,
        status="failed",
        error=f"{name} stopped with {exc.__class__.__name__}: {detail}",
    )


def _log_failure(result: StageResult) -> None:
    path = run_log.append_log(
        f"FAILED {result.name} runid={result.runid or '-'} "
        f"in={result.input_rows} out={result.output_rows} "
        f"error={result.error or 'unknown'}"
    )
    print(f"  logged to {path} (daily file; older than {run_log.KEEP_DAYS} days auto-deleted)")


def _run_stage(
    name: str,
    fn,
    *,
    upstream_uc1_runid: str | None = None,
) -> StageResult:
    meta = _STAGE_META[name]
    runid = run_meta.new_runid()

    try:
        if name == "UC1":
            result = fn()
        else:
            result = fn(upstream_uc1_runid=upstream_uc1_runid)
    except NotImplementedError as exc:
        result = _as_failed(name, exc, runid=runid)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        result = _as_failed(name, exc, runid=runid)

    if not isinstance(result, StageResult):
        result = StageResult(
            name=name,
            runid=runid,
            status="failed",
            error=(
                f"{name} must return StageResult; "
                f"got {type(result).__name__}. Update the engine wrapper."
            ),
        )
    else:
        result.runid = result.runid or runid

    if result.ok and name == "UC3":
        # UC3 creates its modelrun and changed layoutrecommendation rows in one
        # database transaction.  Re-upserting its lineage through PostgREST
        # here would be a redundant, non-atomic second write.
        print(f"{name}: modelrun saved atomically with recommendations runid={result.runid}")
        run_log.append_log(
            f"SUCCESS {name} runid={result.runid} "
            f"in={result.input_rows} out={result.output_rows}"
        )
    elif result.ok:
        try:
            saved = run_meta.record_successful_run(
                runid=result.runid,
                runtype=meta["runtype"],
                algorithmversion=meta["algorithmversion"],
                config_section=meta["config_section"],
                inputrows=result.input_rows,
                outputrows=result.output_rows,
                upstreamrunid=upstream_uc1_runid,
            )
            result.runid = saved
            print(f"{name}: modelrun saved (success) runid={saved}")
            run_log.append_log(
                f"SUCCESS {name} runid={saved} "
                f"in={result.input_rows} out={result.output_rows}"
            )
        except Exception as exc:  # noqa: BLE001
            result = StageResult(
                name=name,
                runid=result.runid,
                status="failed",
                input_rows=result.input_rows,
                output_rows=result.output_rows,
                error=f"Engine ok but could not save modelrun: {exc}",
            )
            _log_failure(result)
    else:
        _log_failure(result)

    return result


def run_pipeline(*, skip_uc2: bool = False, skip_uc3: bool = False) -> int:
    """Run UC1 then UC2 then UC3. Returns process exit code (0 = all ok)."""
    print("MedFlow engine run: UC1 -> UC2 -> UC3 (UC4 is UI-only)")
    print("Fail-stop is on: a failed stage skips dependents.")
    print("Success -> Supabase modelrun. Failure -> logs/engine_runs_YYYY-MM-DD.log\n")

    uc1 = _run_stage("UC1", run_uc1)
    _print_result(uc1)
    if not uc1.ok:
        print(
            "\nSTOP: UC1 failed - UC2 and UC3 were not started "
            "(they need productrelationship / affinity data)."
        )
        print("Fix UC1, then re-run: python3 -m engines.run_all")
        return 1

    if not skip_uc2:
        uc2 = _run_stage("UC2", run_uc2, upstream_uc1_runid=uc1.runid)
        _print_result(uc2)
        if not uc2.ok:
            print(
                "\nSTOP: UC2 failed - UC3 was not started. "
                f"UC1 affinity runid={uc1.runid} is still available to inspect."
            )
            print("Fix UC2, then re-run the pipeline.")
            return 1
    else:
        print("UC2: skipped (--skip-uc2)")

    if not skip_uc3:
        uc3 = _run_stage("UC3", run_uc3, upstream_uc1_runid=uc1.runid)
        _print_result(uc3)
        if not uc3.ok:
            print(
                "\nSTOP: UC3 failed. "
                f"UC1 affinity runid={uc1.runid} was not mixed into a new layout."
            )
            print("Fix UC3, then re-run the pipeline.")
            return 1
        print(
            f"\nUC4 (digital twin): open the planner UI and load "
            f"layout runid={uc3.runid} (not batched in this script)."
        )
    else:
        print("UC3: skipped (--skip-uc3)")

    print("\nPipeline finished successfully.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run MedFlow batch engines in order: UC1 → UC2 → UC3."
    )
    parser.add_argument(
        "--skip-uc2",
        action="store_true",
        help="Run UC1 (and UC3 unless --skip-uc3) without UC2.",
    )
    parser.add_argument(
        "--skip-uc3",
        action="store_true",
        help="Stop after UC1/UC2; do not run layout.",
    )
    args = parser.parse_args(argv)
    return run_pipeline(skip_uc2=args.skip_uc2, skip_uc3=args.skip_uc3)


if __name__ == "__main__":
    raise SystemExit(main())
