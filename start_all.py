#!/usr/bin/env python3
"""Load .env.local, ping FYP MedFlow DB, then start Vite.

  python start_all.py --check   # env + ping; non-zero if anon RLS is still closed
  python start_all.py           # ping, then npm run dev
"""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
REQUIRED = (
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
)


def resolve_command(cmd: list[str]) -> list[str]:
    if not cmd:
        return cmd

    executable = cmd[0]
    resolved = shutil.which(executable)
    if not resolved and os.name == "nt":
        resolved = shutil.which(f"{executable}.cmd")
    if resolved:
        return [resolved, *cmd[1:]]
    return cmd


def run(cmd: list[str]) -> None:
    cmd = resolve_command(cmd)
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(ROOT), check=True)


def load_env() -> None:
    env_path = ROOT / ".env.local"
    if not env_path.exists():
        raise SystemExit(
            "Missing .env.local (gitignored) at the repo root. Add "
            "VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY."
        )
    try:
        from dotenv import load_dotenv
    except ImportError:
        raise SystemExit("Install Python deps first: pip install -r requirements.txt") from None

    load_dotenv(env_path, override=True)
    missing = [name for name in REQUIRED if not os.getenv(name)]
    if missing:
        raise SystemExit(f".env.local is missing: {', '.join(missing)}")
    os.environ.setdefault("SUPABASE_URL", os.getenv("VITE_SUPABASE_URL", "").rstrip("/"))
    print(f"Loaded {env_path} ({os.getenv('VITE_SUPABASE_URL')})")


def ping_supabase() -> int:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from scripts.setup_supabase import check_project

    return check_project()


def ensure_port_available(port: int, service: str) -> None:
    """Fail clearly instead of starting alongside an older local session."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            raise SystemExit(
                f"Cannot start {service}: port {port} is already in use. "
                "Close the older MedFlow dashboard session, then run python start_all.py again."
            ) from None


def deps_stale() -> bool:
    """True if node_modules is missing or older than package.json / package-lock.json."""
    installed = ROOT / "node_modules" / ".package-lock.json"
    if not installed.exists():
        return True
    installed_at = installed.stat().st_mtime
    manifests = (ROOT / "package.json", ROOT / "package-lock.json")
    return any(p.exists() and p.stat().st_mtime > installed_at for p in manifests)


def start_vite(env: dict[str, str] | None = None) -> bool:
    """Run Vite, returning False when another launcher won the startup race."""
    if deps_stale():
        run(["npm", "install"])
    print("Planner: http://127.0.0.1:5173/")
    command = resolve_command(["npm", "run", "dev"])
    print(f"+ {' '.join(command)}")
    completed = subprocess.run(command, cwd=str(ROOT), check=False, env=env)
    if completed.returncode == 0:
        return True
    print(
        "The dashboard did not start. If Vite reported that port 5173 is already in use, "
        "MedFlow is already running at http://127.0.0.1:5173/; keep that first session open."
    )
    return False


def start_uc3_controller() -> tuple[subprocess.Popen, dict[str, str]]:
    """Start the credentialed UC3 controller on loopback only."""
    token = secrets.token_urlsafe(32)
    env = os.environ.copy()
    env["UC3_CONTROLLER_TOKEN"] = token
    process = subprocess.Popen(
        [sys.executable, "-m", "engines.uc3.controller", "--token", token],
        cwd=str(ROOT),
        env=env,
    )
    for _ in range(30):
        if process.poll() is not None:
            break
        try:
            with urlopen("http://127.0.0.1:8765/api/uc3/health", timeout=0.25) as response:
                if response.status == 200:
                    return process, env
        except URLError:
            time.sleep(0.1)

    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
    raise SystemExit(
        "UC3's local layout-generation service could not start on port 8765. "
        "Stop an older dashboard session and run python start_all.py again."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Boot the MedFlow planner.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate .env.local and ping Supabase, then exit.",
    )
    args = parser.parse_args()
    load_env()
    if not args.check:
        ensure_port_available(5173, "the dashboard")
        ensure_port_available(8765, "the UC3 layout-generation service")
    code = ping_supabase()
    if args.check:
        return code
    if code != 0:
        print("Starting Vite anyway; paste sql/policies/002_anon_read.sql for anon SELECT.")
    controller, vite_env = start_uc3_controller()
    try:
        start_vite(vite_env)
    finally:
        controller.terminate()
        try:
            controller.wait(timeout=5)
        except subprocess.TimeoutExpired:
            controller.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
