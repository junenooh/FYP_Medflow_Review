"""Write successful modelrun rows to Supabase (lineage for planner outputs).

Uses the existing modelrun columns only — no schema changes:
  runid, runtype, generatedate, algorithmversion, parametersignature

Failures / debug go to local daily logs via engines.run_log — not to Supabase.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone

from engines.shared.db.config import load_shared_config
from engines.shared.db.supabase_client import get_service_client


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_runid() -> str:
    return str(uuid.uuid4())


def parameter_signature(
    section: str | None = None,
    *,
    inputrows: int = 0,
    outputrows: int = 0,
    upstreamrunid: str | None = None,
) -> str:
    """Short fingerprint of shared_config plus compact run extras.

    Kept inside parametersignature so we do not add DB columns.
    """
    cfg = load_shared_config()
    payload = cfg.get(section, cfg) if section else cfg
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    parts = [
        f"{section or 'all'}:{digest}",
        f"in={inputrows}",
        f"out={outputrows}",
        f"status=success",
    ]
    if upstreamrunid:
        parts.append(f"upstream={upstreamrunid}")
    return "|".join(parts)


def record_successful_run(
    *,
    runid: str | None = None,
    runtype: str,
    algorithmversion: str,
    config_section: str | None = None,
    inputrows: int = 0,
    outputrows: int = 0,
    upstreamrunid: str | None = None,
) -> str:
    """Insert one successful modelrun row using the live schema only."""
    runid = runid or new_runid()
    row = {
        "runid": runid,
        "runtype": runtype,
        "generatedate": _utcnow(),
        "algorithmversion": algorithmversion,
        "parametersignature": parameter_signature(
            config_section,
            inputrows=inputrows,
            outputrows=outputrows,
            upstreamrunid=upstreamrunid,
        ),
    }
    try:
        get_service_client().table("modelrun").upsert(row).execute()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "Could not insert successful modelrun. "
            "Check SUPABASE_SERVICE_ROLE_KEY in .env.local. "
            f"Original error: {exc}"
        ) from exc
    return runid
