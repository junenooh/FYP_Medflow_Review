"""Shared pytest setup for MedFlow tests."""

import dotenv

# engines/uc1/arm.py raises at import time when .env.local is missing.
# Unit tests never connect to Supabase, so stub the loader out to keep
# the suite runnable on any machine (and never read real credentials).
dotenv.load_dotenv = lambda *args, **kwargs: True
