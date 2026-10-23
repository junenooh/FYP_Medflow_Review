#!/usr/bin/env python3
"""Check the FYP MedFlow DB Supabase project and print table counts."""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engines.shared.db.tables import TABLE_NAMES  # noqa: E402

load_dotenv(ROOT / ".env.local")


def project_url() -> str:
    url = os.getenv("VITE_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    if not url:
        raise SystemExit("Missing VITE_SUPABASE_URL in .env.local")
    return url.rstrip("/")


def project_ref(url: str) -> str:
    host = urlparse(url).hostname or ""
    return host.split(".")[0]


def rest_count(url: str, key: str, table: str) -> tuple[int, str | None]:
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}?select=*&limit=1",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Prefer": "count=exact",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            rng = resp.headers.get("content-range") or ""
            total = rng.split("/")[-1]
            return int(total) if total.isdigit() else 0, None
    except urllib.error.HTTPError as exc:
        return -1, exc.read().decode()[:200]


def check_project() -> int:
    url = project_url()
    ref = project_ref(url)
    anon = os.getenv("VITE_SUPABASE_ANON_KEY") or ""
    service = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not anon:
        raise SystemExit("Fill VITE_SUPABASE_ANON_KEY in .env.local")
    if not service:
        raise SystemExit("Fill SUPABASE_SERVICE_ROLE_KEY in .env.local")

    print(f"Project {ref}")
    print(f"Dashboard https://supabase.com/dashboard/project/{ref}")
    print(f"{'table':34} {'anon':>8} {'service':>8}")
    rls_blocked = False
    for table in TABLE_NAMES:
        anon_n, anon_err = rest_count(url, anon, table)
        svc_n, svc_err = rest_count(url, service, table)
        print(f"{table:34} {anon_n:8} {svc_n:8}")
        if svc_err:
            print(" ", svc_err)
        if anon_err and anon_n < 0:
            print(" ", anon_err)
        if svc_n > 0 and anon_n == 0:
            rls_blocked = True

    if rls_blocked:
        print("\nAnon cannot see some rows. Paste sql/policies/002_anon_read.sql in:")
        print(f"  https://supabase.com/dashboard/project/{ref}/sql/new")
        return 1
    print("\nAnon read looks OK.")
    return 0


def main() -> int:
    return check_project()


if __name__ == "__main__":
    raise SystemExit(main())
