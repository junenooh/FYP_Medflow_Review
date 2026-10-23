"""Service-role Supabase client for engine writes.

The dashboard uses the anon key in client/src/shared/data/supabase.js.
Never import this module from client code or log the JWT.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

from engines.shared.paths import REPO_ROOT

load_dotenv(REPO_ROOT / ".env.local")


def _require_service_env() -> tuple[str, str]:
    url = (os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL") or "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
    missing = []
    if not url:
        missing.append("SUPABASE_URL or VITE_SUPABASE_URL")
    if not key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if missing:
        raise RuntimeError(
            "Missing " + ", ".join(missing) + " in gitignored .env.local at the repo root."
        )
    return url, key


def get_service_client():
    """PostgREST client as service_role (bypasses RLS). Used only by engines/scripts."""
    url, key = _require_service_env()
    from supabase import create_client

    return create_client(url, key)
