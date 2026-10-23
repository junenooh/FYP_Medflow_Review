"""Apply sql/uc2/uc2_setup.sql to the database.

WHY THIS EXISTS
    A .sql file sitting in the repo does nothing. Postgres functions live
    inside the database, so the file has to be executed against it once, and
    again every time it changes. Doing that by hand in the Supabase SQL Editor
    works, but nothing stops someone editing the file and forgetting to paste
    it -- the database then keeps running the old function bodies with no
    warning at all.

    This module removes the manual step. The .sql file stays the single source
    of truth; this reads it and executes it.

        python3 -m engines.uc2.migrate            # apply
        python3 -m engines.uc2.migrate --check    # report drift, change nothing

HOW IT CONNECTS
    A direct Postgres connection, which is the only route that can execute
    arbitrary SQL. The REST API can call functions but cannot create them.

    Needs DATABASE_URL in the gitignored .env.local at the repo root -- the
    SESSION POOLER connection string from Supabase (Settings -> Database ->
    Connection string -> Session pooler), not the direct one, whose host
    resolves to IPv6 only:

        DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

DRIFT
    uc2_setup.sql defines uc2_schema_version(). engines/uc2/version.py must
    match it. The engine checks this at startup, so a forgotten migration
    fails loudly instead of producing quietly wrong numbers.

STATUS
    This needs a direct Postgres connection, which has not worked from your
    machine yet (the pooler string). Until it does, paste
    sql/uc2/uc2_setup.sql into the Supabase SQL Editor instead -- the result
    is identical.
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

from engines.shared.paths import REPO_ROOT
from engines.uc2.version import SCHEMA_VERSION

SQL_FILE = REPO_ROOT / "sql" / "uc2" / "uc2_setup.sql"

# One value, shared with replenishment.py -- see engines/uc2/version.py.
EXPECTED_VERSION = SCHEMA_VERSION


def _dsn() -> str:
    load_dotenv(REPO_ROOT / ".env.local", override=True)
    dsn = (
        os.getenv("DATABASE_URL")
        or os.getenv("SUPABASE_DB_URL")
        or os.getenv("POSTGRES_URL")
        or ""
    ).strip()
    if not dsn:
        raise RuntimeError(
            "Missing DATABASE_URL in the gitignored .env.local at the repo root.\n"
            "Use the SESSION POOLER string from Supabase: Settings -> Database\n"
            "-> Connection string -> Session pooler."
        )
    return dsn


def split_statements(sql: str) -> list[str]:
    """Split a SQL script on top-level semicolons.

    psycopg sends one statement per execute(), and a naive split on ';' would
    tear the function bodies apart -- they are full of semicolons inside
    $$ ... $$ quoting. This walks the text tracking line comments, block
    comments, single-quoted strings and dollar-quoted blocks, and only splits
    on a semicolon that is outside all of them.
    """
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)
    tag: str | None = None  # active dollar-quote tag, e.g. "$$" or "$body$"

    while i < n:
        ch = sql[i]

        if tag is not None:
            if sql.startswith(tag, i):
                buf.append(tag)
                i += len(tag)
                tag = None
            else:
                buf.append(ch)
                i += 1
            continue

        # line comment
        if ch == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j == -1 else j + 1
            buf.append(sql[i:j])
            i = j
            continue

        # block comment (Postgres allows nesting)
        if ch == "/" and sql.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if sql.startswith("/*", j):
                    depth += 1
                    j += 2
                elif sql.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            buf.append(sql[i:j])
            i = j
            continue

        # single-quoted string, '' escapes a quote
        if ch == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            buf.append(sql[i:j])
            i = j
            continue

        # dollar quote opener: $$ or $tag$ where tag is an identifier
        if ch == "$":
            j = i + 1
            while j < n and (sql[j].isalnum() or sql[j] == "_"):
                j += 1
            if j < n and sql[j] == "$":
                tag = sql[i : j + 1]
                buf.append(tag)
                i = j + 1
                continue

        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        out.append(tail)

    # Drop fragments that are only comments or whitespace.
    return [s for s in out if _has_code(s)]


def _has_code(stmt: str) -> bool:
    for line in stmt.splitlines():
        s = line.strip()
        if s and not s.startswith("--"):
            return True
    return False


def _head(stmt: str, width: int = 66) -> str:
    """First real line of a statement, skipping its comment banner."""
    for line in stmt.splitlines():
        s = line.strip()
        if s and not s.startswith("--"):
            return " ".join(s.split())[:width]
    return "(comment only)"


def installed_version(dsn: str | None = None) -> str | None:
    """Version currently installed in the database, or None if absent."""
    import psycopg

    with psycopg.connect(dsn or _dsn()) as conn:
        try:
            row = conn.execute("SELECT public.uc2_schema_version()").fetchone()
        except Exception:
            return None
    return row[0] if row else None


def apply() -> str:
    """Execute the whole file in one transaction. Returns the new version."""
    import psycopg

    sql = SQL_FILE.read_text(encoding="utf-8")
    statements = split_statements(sql)
    print(f"  {SQL_FILE.relative_to(REPO_ROOT)}: {len(statements)} statements")

    with psycopg.connect(_dsn()) as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            for k, stmt in enumerate(statements, 1):
                head = _head(stmt)
                try:
                    cur.execute(stmt)
                except Exception as exc:
                    conn.rollback()
                    raise RuntimeError(
                        f"statement {k} failed -- nothing was applied\n"
                        f"  {head}...\n  {exc}"
                    ) from exc
                print(f"    {k:>2}. {head}")
        conn.commit()
        version = conn.execute("SELECT public.uc2_schema_version()").fetchone()[0]

    return version


def main(argv: list[str]) -> int:
    check_only = "--check" in argv

    if check_only:
        found = installed_version()
        if found is None:
            print(f"  not installed (expected {EXPECTED_VERSION})")
            return 1
        if found != EXPECTED_VERSION:
            print(f"  DRIFT: database has {found}, repo expects {EXPECTED_VERSION}")
            print("  run: python3 -m engines.uc2.migrate")
            return 1
        print(f"  up to date ({found})")
        return 0

    version = apply()
    if version != EXPECTED_VERSION:
        print(
            f"  WARNING: applied file reports {version}, but engines/uc2/version.py "
            f"says {EXPECTED_VERSION}. Update one of them."
        )
        return 1
    print(f"  applied, database now at {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))