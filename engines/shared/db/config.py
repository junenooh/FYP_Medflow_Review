"""Load repo-root shared_config.json (ARM / ROP thresholds, not secrets)."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from engines.shared.paths import REPO_ROOT


@lru_cache(maxsize=1)
def load_shared_config() -> dict[str, Any]:
    path = REPO_ROOT / "shared_config.json"
    return json.loads(path.read_text(encoding="utf-8"))
