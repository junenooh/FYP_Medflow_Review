# Tests

Run the Python engine tests with `python -m pytest` (install with `pip install -r requirements.txt`).

| Suite | File | Documentation |
|---|---|---|
| UC1 unit tests (engine `engines/uc1/arm_jeremiahVer.py`) | `tests/engines/test_uc1_arm.py` | `docs/testing/uc1-unit-tests.md` |
| UC1 relationship labels (`node --test`) | `tests/frontend/test_uc1_relationship_labels.mjs` | `docs/testing/uc1-unit-tests.md` |
| UC2 engine unit tests | `tests/engines/test_uc2_replenishment.py` | `docs/testing/uc2-unit-tests.md` |
| UC2 page-logic unit tests (`node --test`) | `tests/frontend/test_uc2_replenishment.mjs` | `docs/testing/uc2-unit-tests.md` |
| UC2 policy data verification (reads the live database; skipped without `.env.local`) | `tests/integration/test_uc2_policy_db.py` | `docs/testing/uc2-unit-tests.md` |

Layout:

- place Vite route, component and browser tests in `tests/frontend/`;
- place UC1–UC3 Python unit and integration tests in `tests/engines/`.

Name tests after behavior, for example `test_replenishment_policy.py` or `connection-test.spec.js`. Test fixtures belong beside the tests that consume them; do not place production credentials here.
