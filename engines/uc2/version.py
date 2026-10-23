"""The UC2 database schema version this repo expects.

Must match the literal returned by uc2_schema_version() in
sql/uc2/uc2_setup.sql. The engine refuses to run when they differ, because
that means the SQL file was edited but not applied (or applied from an older
copy), and the database is running stale function bodies.

Kept in its own module so migrate.py and replenishment.py share one value
without importing each other.
"""

SCHEMA_VERSION = "uc2-3.3"