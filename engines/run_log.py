"""Local daily engine logs (failures / debug). Not written to Supabase."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from engines.shared.paths import REPO_ROOT

LOG_DIR = REPO_ROOT / "logs"
LOG_PREFIX = "engine_runs_"
LOG_SUFFIX = ".log"
KEEP_DAYS = 14  # delete daily logs older than this
_DATE_RE = re.compile(
    rf"^{re.escape(LOG_PREFIX)}(\d{{4}}-\d{{2}}-\d{{2}}){re.escape(LOG_SUFFIX)}$"
)


def _today() -> date:
    return datetime.now(timezone.utc).date()


def todays_log_path() -> Path:
    return LOG_DIR / f"{LOG_PREFIX}{_today().isoformat()}{LOG_SUFFIX}"


def purge_old_logs(*, keep_days: int = KEEP_DAYS) -> list[Path]:
    """Delete engine_runs_YYYY-MM-DD.log files older than keep_days. Returns removed paths."""
    if not LOG_DIR.is_dir():
        return []
    cutoff = _today() - timedelta(days=keep_days)
    removed: list[Path] = []
    for path in LOG_DIR.glob(f"{LOG_PREFIX}*{LOG_SUFFIX}"):
        match = _DATE_RE.match(path.name)
        if not match:
            continue
        try:
            file_day = date.fromisoformat(match.group(1))
        except ValueError:
            continue
        if file_day < cutoff:
            path.unlink(missing_ok=True)
            removed.append(path)
    return removed


def append_log(message: str, *, keep_days: int = KEEP_DAYS) -> Path:
    """Append a line to today's log and purge files older than keep_days."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    purge_old_logs(keep_days=keep_days)
    path = todays_log_path()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = message if message.endswith("\n") else message + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{stamp} {line}")
    return path
