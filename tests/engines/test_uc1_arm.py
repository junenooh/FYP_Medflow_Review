"""
Unit tests for the UC1 engine (Association Rule Mining, FP-Growth).

Module under test: engines/uc1/arm_jeremiahVer.py -- the engine that
engines/uc1/__init__.py exports and the scheduled UC1 workflow runs.
(engines/uc1/arm.py is the earlier version and is no longer run.)

No database is used: every test builds a small in-memory set of hospital
requests whose support / confidence / lift were worked out by hand, and the
database connection is replaced with a mock where needed.

Test IDs (TC-UC1-UT-xxx) match docs/testing/uc1-unit-tests.md.

Hand-worked dataset (SAMPLE_REQUESTS): the 11 requests below, each repeated
10 times -> 110 requests, 100 multi-item baskets. Repeating keeps every
ratio the same while clearing the engine's 20-basket minimum per rule.
    R1-R3  A,B        R4  A,B,C     R5  A,C      R6  B,C
    R7-R8  D,E        R9  C,D       R10 B,E      R11 F  (single item)

    A=0.5  B=0.6  C=0.4  D=0.3  E=0.3
    A+B=0.4 -> A->B conf 0.80 lift 1.33 (Strong)   | B->A conf 0.67 lift 1.33 (Moderate)
    D+E=0.2 -> D->E conf 0.67 lift 2.22 (Moderate) | E->D conf 0.67 lift 2.22 (Moderate)
    A->C conf 0.40 (fails confidence), C->A lift 1.00 (fails lift);
    every other pair is on fewer than 20 baskets.
"""

from unittest.mock import MagicMock

import pandas as pd
import pytest

from engines.uc1 import arm_jeremiahVer as arm


def make_txns(requests, warehouse="WH002"):
    """{requestid: [productids]} -> DataFrame shaped like load_transactions()."""
    rows = [(rid, pid, warehouse) for rid, pids in requests.items() for pid in pids]
    return pd.DataFrame(rows, columns=["orderid", "productid", "warehouseid"])


def repeat(requests, times):
    """Each request `times` times, under new ids (R1 -> R1-0 .. R1-9)."""
    return {f"{rid}-{i}": pids for rid, pids in requests.items() for i in range(times)}


BASE_REQUESTS = {
    "R1": ["A", "B"], "R2": ["A", "B"], "R3": ["A", "B"],
    "R4": ["A", "B", "C"], "R5": ["A", "C"], "R6": ["B", "C"],
    "R7": ["D", "E"], "R8": ["D", "E"], "R9": ["C", "D"],
    "R10": ["B", "E"], "R11": ["F"],
}
SAMPLE_REQUESTS = repeat(BASE_REQUESTS, 10)


def rule_key(rule):
    return (tuple(sorted(rule["antecedents"])), tuple(sorted(rule["consequents"])))


def rule_keys(rules):
    return {rule_key(r) for _, r in rules.iterrows()}


@pytest.fixture
def sample_rules():
    return arm.mine_rules(arm.build_basket_matrix(make_txns(SAMPLE_REQUESTS)))


# ------------------------------------------------------------------
# build_basket_matrix
# ------------------------------------------------------------------
def test_ut001_duplicate_product_lines_count_once():
    baskets = arm.build_basket_matrix(make_txns({"R1": ["A", "A", "B"], "R2": ["C", "C"]}))

    assert baskets.loc["R1"].to_dict() == {"A": True, "B": True}
    assert "R2" not in baskets.index   # one product on two lines is still a single-item request


def test_ut002_single_item_requests_are_dropped():
    baskets = arm.build_basket_matrix(make_txns(BASE_REQUESTS))

    assert "R11" not in baskets.index
    assert len(baskets) == 10


# ------------------------------------------------------------------
# mine_rules
# ------------------------------------------------------------------
def test_ut003_only_expected_rules_pass_the_gates(sample_rules):
    assert rule_keys(sample_rules) == {
        (("A",), ("B",)), (("B",), ("A",)),
        (("D",), ("E",)), (("E",), ("D",)),
    }


def test_ut004_metrics_match_hand_calculation(sample_rules):
    rules = {rule_key(r): r for _, r in sample_rules.iterrows()}

    a_to_b = rules[(("A",), ("B",))]
    assert a_to_b["support"] == pytest.approx(0.40)
    assert a_to_b["confidence"] == pytest.approx(0.80)
    assert a_to_b["lift"] == pytest.approx(0.80 / 0.60)

    d_to_e = rules[(("D",), ("E",))]
    assert d_to_e["support"] == pytest.approx(0.20)
    assert d_to_e["confidence"] == pytest.approx(2 / 3)
    assert d_to_e["lift"] == pytest.approx((2 / 3) / 0.30)


def test_ut005_low_confidence_and_low_lift_rules_are_filtered(sample_rules):
    keys = rule_keys(sample_rules)

    assert (("A",), ("C",)) not in keys   # confidence 0.40 < 0.50
    assert (("C",), ("A",)) not in keys   # lift 1.00 < 1.20


def test_ut006_thresholds_are_configurable():
    baskets = arm.build_basket_matrix(make_txns(SAMPLE_REQUESTS))
    rules = arm.mine_rules(baskets, baseline_confidence=0.70)

    assert rule_keys(rules) == {(("A",), ("B",))}


def test_ut007_multi_item_consequents_are_excluded():
    # X, Y, Z always requested together, so X -> {Y, Z} would qualify.
    requests = {f"X{i}": ["X", "Y", "Z"] for i in range(50)}
    requests.update({f"P{i}": ["P", "Q"] for i in range(50)})
    rules = arm.mine_rules(arm.build_basket_matrix(make_txns(requests)))

    assert not rules.empty
    assert (rules["consequents"].apply(len) == 1).all()


def test_ut008_empty_basket_matrix_returns_no_rules():
    assert arm.mine_rules(pd.DataFrame()).empty


def test_ut019_confidence_between_040_and_050_is_rejected():
    # 200 baskets: X in 90, X+Y in 40 -> X->Y confidence 0.444, lift 2.22.
    requests = {f"XY{i}": ["X", "Y"] for i in range(40)}
    requests.update({f"XZ{i}": ["X", "Z"] for i in range(50)})
    requests.update({f"PQ{i}": ["P", "Q"] for i in range(110)})
    baskets = arm.build_basket_matrix(make_txns(requests))

    default = rule_keys(arm.mine_rules(baskets))
    loose = rule_keys(arm.mine_rules(baskets, baseline_confidence=0.40))

    assert (("X",), ("Y",)) not in default   # 0.444 < 0.50
    assert (("X",), ("Y",)) in loose          # proves confidence is the reason


def test_ut020_support_below_002_is_rejected():
    # 2,000 baskets: X+Y in 30 -> support 0.015 (on 30 baskets, so the
    # 20-basket minimum is met and only the 0.02 support gate rejects it).
    requests = {f"XY{i}": ["X", "Y"] for i in range(30)}
    requests.update({f"PQ{i}": ["P", "Q"] for i in range(1970)})
    baskets = arm.build_basket_matrix(make_txns(requests))

    default = rule_keys(arm.mine_rules(baskets))
    loose = rule_keys(arm.mine_rules(baskets, min_support=0.01, baseline_support=0.01))

    assert (("X",), ("Y",)) not in default   # 0.015 < 0.02
    assert (("X",), ("Y",)) in loose          # proves support is the reason


def test_ut024_rule_needs_at_least_20_baskets():
    # 40 baskets: X+Y in 19 -> support 0.475, confidence 1.0, lift 2.1,
    # but seen on only 19 requests (< MIN_PAIR_COUNT 20).
    requests = {f"XY{i}": ["X", "Y"] for i in range(19)}
    requests.update({f"PQ{i}": ["P", "Q"] for i in range(21)})
    baskets = arm.build_basket_matrix(make_txns(requests))

    default = rule_keys(arm.mine_rules(baskets))
    loose = rule_keys(arm.mine_rules(baskets, min_pair_count=10))

    assert (("X",), ("Y",)) not in default   # 19 < 20 baskets
    assert (("X",), ("Y",)) in loose          # proves the basket minimum is the reason


def test_ut025_itemsets_are_capped_at_four_products():
    # A-E always requested together (lift 2 against the P,Q requests), so
    # without a cap FP-Growth would build 5-product rules.
    requests = {f"AE{i}": ["A", "B", "C", "D", "E"] for i in range(30)}
    requests.update({f"PQ{i}": ["P", "Q"] for i in range(30)})
    rules = arm.mine_rules(arm.build_basket_matrix(make_txns(requests)))

    sizes = (rules["antecedents"].apply(len) + rules["consequents"].apply(len))
    assert not rules.empty
    assert sizes.max() == 4


# ------------------------------------------------------------------
# classify
# ------------------------------------------------------------------
@pytest.mark.parametrize(
    ("support", "confidence", "lift", "expected"),
    [
        (0.05, 0.70, 1.20, "Strong"),     # exactly on the Strong band
        (0.049, 0.70, 1.20, "Moderate"),  # support just below Strong
        (0.05, 0.699, 1.20, "Moderate"),  # confidence just below Strong
        (0.03, 0.60, 1.20, "Moderate"),   # exactly on the Moderate band
        (0.029, 0.60, 1.20, "Weak"),      # support just below Moderate
        (0.03, 0.599, 1.20, "Weak"),      # confidence just below Moderate
        (0.02, 0.50, 1.20, "Weak"),       # passes the gates only
    ],
)
def test_ut009_classify_bands(support, confidence, lift, expected):
    assert arm.classify(support, confidence, lift) == expected


def test_ut010_lift_does_not_change_the_grade():
    # Lift is a gate in mine_rules, not a ranking factor.
    assert arm.classify(0.10, 0.80, 1.21) == "Strong"
    assert arm.classify(0.10, 0.80, 15.0) == "Strong"
    assert arm.classify(0.04, 0.65, 1.21) == arm.classify(0.04, 0.65, 15.0) == "Moderate"


# ------------------------------------------------------------------
# rules_to_rows / mine_scope
# ------------------------------------------------------------------
def test_ut011_rules_convert_to_linked_database_rows():
    rules = pd.DataFrame([{
        "antecedents": frozenset({"C", "A"}), "consequents": frozenset({"B"}),
        "support": 0.10, "confidence": 0.75, "lift": 1.60,
    }])
    pr_rows, ant_rows = arm.rules_to_rows(rules, "WH002", "run-1", 25)

    (rid, wh, consequent, size, *_rest, strength, count, source, _day, run_id), = pr_rows
    assert (wh, consequent, size, strength, count, source, run_id) == (
        "WH002", "B", 3, "Strong", 25, "FP-GROWTH", "run-1")
    assert ant_rows == [(rid, "A"), (rid, "C")]


def test_ut012_scope_with_only_single_item_requests_gives_no_rules():
    label, pr_rows, ant_rows, request_count, basket_count = arm.mine_scope(
        make_txns({"R1": ["A"], "R2": ["B"]}), "WH005", "run-1")

    assert (label, pr_rows, ant_rows) == ("WH005", [], [])
    assert (request_count, basket_count) == (2, 0)


def test_ut013_scope_counts_requests_and_baskets():
    *_, request_count, basket_count = arm.mine_scope(
        make_txns(SAMPLE_REQUESTS), "WH002", "run-1")

    assert request_count == 110   # every request, including single-item ones
    assert basket_count == 100    # only baskets with 2+ products


def test_ut021_rerun_on_same_data_gives_same_rules():
    def stable(scope):
        # Drop the random relationshipid and run date; keep everything else.
        _, pr_rows, ant_rows, *_ = scope
        return sorted(
            (row[1:10], tuple(sorted(a for rid, a in ant_rows if rid == row[0])))
            for row in pr_rows
        )

    txns = make_txns(SAMPLE_REQUESTS)
    first = stable(arm.mine_scope(txns, "WH001", "run-1"))
    second = stable(arm.mine_scope(txns, "WH001", "run-1"))

    assert first and first == second


# ------------------------------------------------------------------
# run() - network vs subsidiary scopes (database mocked)
# ------------------------------------------------------------------
@pytest.fixture
def fake_db(monkeypatch):
    """Replace connection, extract and load; capture what would be written."""
    captured = {}
    monkeypatch.setattr(arm, "get_connection", MagicMock)
    monkeypatch.setattr(
        arm, "write_all_scopes",
        lambda conn, scopes, run_id: captured.update(scopes=scopes),
    )

    def use_transactions(txns):
        monkeypatch.setattr(arm, "load_transactions", lambda conn, **kw: txns)

    return captured, use_transactions


def two_site_txns():
    """Each subsidiary's hospitals request their own two product pairs (40 requests each)."""
    site2 = {f"S2-{i}": ["A", "B"] for i in range(40)}
    site2.update({f"S2-{i + 40}": ["C", "G"] for i in range(40)})
    site3 = {f"S3-{i}": ["D", "E"] for i in range(40)}
    site3.update({f"S3-{i + 40}": ["H", "K"] for i in range(40)})
    return pd.concat([make_txns(site2, "WH002"), make_txns(site3, "WH003")],
                     ignore_index=True)


def test_ut014_run_mines_network_and_each_subsidiary(fake_db):
    captured, use_transactions = fake_db
    use_transactions(two_site_txns())

    result = arm.run()

    labels = [label for label, _, _ in captured["scopes"]]
    assert labels == ["WH001", "WH002", "WH003"]
    assert result.status == "success"
    assert result.input_rows == 160


def test_ut015_subsidiary_rules_use_only_their_own_requests(fake_db):
    captured, use_transactions = fake_db
    use_transactions(two_site_txns())

    arm.run()

    scopes = {label: (pr, ant) for label, pr, ant in captured["scopes"]}
    assert {row[2] for row in scopes["WH002"][0]} == {"A", "B", "C", "G"}
    assert {row[2] for row in scopes["WH003"][0]} == {"D", "E", "H", "K"}
    assert {row[2] for row in scopes["WH001"][0]} == set("ABCGDEHK")
    assert all(row[8] == 80 for row in scopes["WH002"][0])    # ordercount = requests mined
    assert all(row[8] == 160 for row in scopes["WH001"][0])


def test_ut016_single_site_run_skips_network_scope(fake_db):
    captured, use_transactions = fake_db
    use_transactions(two_site_txns().query("warehouseid == 'WH002'"))

    arm.run("WH002")

    assert [label for label, _, _ in captured["scopes"]] == ["WH002"]


def test_ut017_no_requests_reports_failure(fake_db):
    captured, use_transactions = fake_db
    use_transactions(make_txns({}))

    result = arm.run()

    assert result.status == "failed"
    assert "No hospital request lines found" in result.error
    assert "scopes" not in captured   # nothing written


# ------------------------------------------------------------------
# load_transactions / write_all_scopes (mock connection)
# ------------------------------------------------------------------
def mock_streaming_conn(batches):
    """A connection whose server-side cursor returns `batches`, then nothing."""
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchmany.side_effect = [*batches, []]
    return conn, cur


def test_ut022_extract_reads_last_90_days_of_hospital_requests():
    conn, cur = mock_streaming_conn([[("T1", "A", "WH002"), ("T1", "B", "WH002")]])

    txns = arm.load_transactions(conn)

    sql, params = cur.execute.call_args.args
    assert "FROM stocktransferline" in sql and "JOIN stocktransfer" in sql
    assert "max(transferdate)" in sql and "interval '1 day'" in sql
    assert params == [90]
    assert list(txns.columns) == ["orderid", "productid", "warehouseid"]
    assert len(txns) == 2


def test_ut026_single_site_extract_filters_by_subsidiary():
    conn, cur = mock_streaming_conn([])

    txns = arm.load_transactions(conn, source_warehouse_id="WH002")

    sql, params = cur.execute.call_args.args
    assert "t.sourcewarehouseid = %s" in sql
    assert params == ["WH002", 90]
    assert txns.empty


def test_ut018_write_replaces_rules_per_scope_in_one_transaction(monkeypatch):
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    inserts = []
    monkeypatch.setattr(
        arm.psycopg2.extras, "execute_values",
        lambda _cur, sql, rows, page_size: inserts.append((sql.split("(")[0], rows)),
    )

    arm.write_all_scopes(
        conn,
        [("WH001", [("r1",)], [("r1", "A")]), ("WH002", [], [])],
        "run-1",
    )

    conn.__enter__.assert_called_once()   # single transaction
    sqls = [c.args[0] for c in cur.execute.call_args_list]
    assert sqls[0].startswith("INSERT INTO modelrun")
    deletes = [c.args[1] for c in cur.execute.call_args_list[1:]]
    assert deletes == [("WH001",), ("WH002",)]
    assert [name.strip() for name, _ in inserts] == [
        "INSERT INTO productrelationship",
        "INSERT INTO productrelationshipantecedent",
    ]   # empty WH002 scope deletes old rules but inserts nothing


def test_ut023_modelrun_records_source_thresholds_and_bands():
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value

    arm.write_all_scopes(conn, [("WH001", [], [])], "run-1")

    run_id, run_type, generated, version, signature = cur.execute.call_args_list[0].args[1]
    assert (run_id, run_type, version) == (
        "run-1", "Association Rule Mining", "FP-GROWTH-3.0-gated")
    assert generated is not None
    assert signature == (
        "source=stocktransfer;lookback_days=90;min_support=0.02;support>=0.02;"
        "confidence>=0.5;lift>=1.2;min_pair_count=20;max_len=4;"
        "strong=conf>=0.7&sup>=0.05;moderate=conf>=0.6&sup>=0.03;scopes=1")
