import assert from "node:assert/strict";
import test from "node:test";
import {
  confidenceLabel,
  liftLabel,
  recommendationLabel,
  supportLabel,
} from "../../client/src/features/uc1-relationships/labels.js";

test("confidence labels use the defined reliability bands", () => {
  assert.equal(confidenceLabel(0.7), "Highly Reliable");
  assert.equal(confidenceLabel(0.6), "Reliable");
  assert.equal(confidenceLabel(0.5), "Moderately Reliable");
  assert.equal(confidenceLabel(0.49), "Unreliable");
});

test("support labels use the defined popularity bands", () => {
  assert.equal(supportLabel(0.05), "Very Common");
  assert.equal(supportLabel(0.03), "Common");
  assert.equal(supportLabel(0.049), "Common");
  assert.equal(supportLabel(0.029), "Less Common");
  assert.equal(supportLabel(0.02), "Less Common");
  assert.equal(supportLabel(0.019), "Uncommon");
});

test("lift labels distinguish association from coincidence", () => {
  assert.equal(liftLabel(1.2), "Truly Associated");
  assert.equal(liftLabel(1.19), "Coincidental");
});

test("recommendation labels describe bundle strength", () => {
  assert.equal(recommendationLabel("Strong"), "Best Bundle");
  assert.equal(recommendationLabel("Moderate"), "Recommended Bundle");
  assert.equal(recommendationLabel("Weak"), "Consider Bundle");
});

test("missing or invalid metric values remain visibly unavailable", () => {
  for (const label of [confidenceLabel, supportLabel, liftLabel]) {
    assert.equal(label(null), "—");
    assert.equal(label(""), "—");
    assert.equal(label("not-a-number"), "—");
  }
});
