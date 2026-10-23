"""Loopback-only dashboard controller for the existing UC3 planner.

The browser keeps its read-only Supabase client. This local process retains
the service credential and starts the unchanged New UC3 planner in a child
process when a user requests a fresh recommended layout.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from engines.shared.paths import REPO_ROOT
from engines.uc3.layout import run
from scripts.sim import db as simulation_db


HOST = "127.0.0.1"
PORT = 8765
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_token = ""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(handler: BaseHTTPRequestHandler, status: HTTPStatus, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _run_job(jobid: str) -> None:
    """Run New UC3 unchanged in a child process and publish safe progress."""
    with _jobs_lock:
        _jobs[jobid].update({"status": "running", "phase": "optimizing", "startedat": _utc_now()})
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "engines.uc3.controller", "--child-job", jobid],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
            timeout=30 * 60,
        )
    except subprocess.TimeoutExpired:
        result = {"status": "failed", "error": "UC3 generation exceeded the 30-minute local limit."}
        completed = None
    else:
        try:
            result = json.loads(completed.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            result = {"status": "failed", "error": "UC3 generation ended without a valid result."}

    with _jobs_lock:
        if completed and completed.returncode == 0 and result.get("status") == "success":
            _jobs[jobid].update({
                "status": "succeeded",
                "phase": "complete",
                "runid": result.get("runid"),
                "completedat": _utc_now(),
                "error": None,
            })
        else:
            _jobs[jobid].update({
                "status": "failed",
                "phase": "failed",
                "completedat": _utc_now(),
                "error": str(result.get("error") or "UC3 generation failed."),
            })


def _is_authorized(handler: BaseHTTPRequestHandler) -> bool:
    origin = handler.headers.get("Origin", "")
    return origin in {"http://127.0.0.1:5173", "http://localhost:5173"} and handler.headers.get("X-UC3-Session") == _token


def _has_proxy_token(handler: BaseHTTPRequestHandler) -> bool:
    return handler.headers.get("X-UC3-Session") == _token


def _current_inventory_snapshot(warehouseid: str = "WH001") -> list[dict[str, Any]]:
    """Return the exact latest product-bin inventory snapshot used by UC3.

    The inventory table is historical. PostgREST cannot efficiently express
    this DISTINCT ON snapshot at dashboard scale, so keep the credentialed,
    read-only query in the loopback controller rather than exposing it to the
    browser or changing the database schema.
    """
    with simulation_db.connect(read_only=True) as conn:
        rows = conn.execute(
            """SELECT DISTINCT ON (productid, binid)
                   inventoryid, warehouseid, productid, binid, qtyonhand,
                   expirydate, inventorystatus, lastupdated
                 FROM inventory
                 WHERE warehouseid = %s AND binid IS NOT NULL
                 ORDER BY productid, binid, lastupdated DESC, inventoryid DESC""",
            (warehouseid,),
        ).fetchall()
        conn.rollback()
    fields = ("inventoryid", "warehouseid", "productid", "binid", "qtyonhand", "expirydate", "inventorystatus", "lastupdated")
    return [dict(zip(fields, row, strict=True)) for row in rows]


class ControllerHandler(BaseHTTPRequestHandler):
    server_version = "MedFlowUC3/1"

    def log_message(self, *_args: object) -> None:
        """Avoid logging tokens or browser request details."""

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/uc3/health":
            # The browser uses this to distinguish the correctly launched
            # dashboard (whose Vite proxy adds the launch token) from an old
            # Vite session on the same port.
            _json(self, HTTPStatus.OK, {
                "ok": True,
                "service": "uc3-controller",
                "authorized_proxy": self.headers.get("X-UC3-Session") == _token,
            })
            return
        if path == "/api/uc3/current-snapshot":
            if not _has_proxy_token(self):
                _json(self, HTTPStatus.FORBIDDEN, {"error": "Local UC3 controller authorization failed."})
                return
            try:
                _json(self, HTTPStatus.OK, {
                    "warehouseid": "WH001",
                    "inventory": _current_inventory_snapshot(),
                })
            except Exception as exc:  # noqa: BLE001
                _json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return
        if path.startswith("/api/uc3/jobs/"):
            jobid = path.rsplit("/", 1)[-1]
            with _jobs_lock:
                job = _jobs.get(jobid)
            if job:
                _json(self, HTTPStatus.OK, job)
            else:
                _json(self, HTTPStatus.NOT_FOUND, {"error": "UC3 job was not found."})
            return
        _json(self, HTTPStatus.NOT_FOUND, {"error": "Unknown UC3 controller route."})

    def do_POST(self) -> None:  # noqa: N802
        if not _is_authorized(self):
            _json(self, HTTPStatus.FORBIDDEN, {"error": "Local UC3 controller authorization failed."})
            return
        if urlparse(self.path).path != "/api/uc3/jobs":
            _json(self, HTTPStatus.NOT_FOUND, {"error": "Unknown UC3 controller route."})
            return
        with _jobs_lock:
            if any(job["status"] in {"queued", "running"} for job in _jobs.values()):
                _json(self, HTTPStatus.CONFLICT, {"error": "A UC3 generation job is already running."})
                return
            jobid = str(uuid.uuid4())
            _jobs[jobid] = {"jobid": jobid, "status": "queued", "phase": "loading", "requestedat": _utc_now()}
        threading.Thread(target=_run_job, args=(jobid,), daemon=True).start()
        _json(self, HTTPStatus.ACCEPTED, _jobs[jobid])


def _run_child(jobid: str) -> int:
    # No upstream engine is called here. New UC3 reads its saved UC1/UC2 data
    # within layout.run(), keeping its heuristic implementation authoritative.
    result = run()
    print(json.dumps({"jobid": jobid, "status": result.status, "runid": result.runid, "error": result.error}))
    return 0 if result.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MedFlow UC3 local controller")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--token")
    parser.add_argument("--child-job")
    args = parser.parse_args(argv)
    if args.child_job:
        return _run_child(args.child_job)

    global _token
    _token = args.token or os.environ.get("UC3_CONTROLLER_TOKEN", "")
    if not _token:
        raise SystemExit("UC3 controller requires a session token")
    server = ThreadingHTTPServer((HOST, args.port), ControllerHandler)
    print(f"UC3 controller: http://{HOST}:{args.port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
