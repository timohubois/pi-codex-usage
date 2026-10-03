import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetBalance } from "../extensions/codex-usage.ts";
import { actionHint, budgetWarning, HISTORY_MS, withRecentRates } from "../lib/pacing.ts";

const hour = 3_600_000;
const now = Date.parse("2026-10-02T20:00:00Z");
const fiveHour = { usedPercent: 40, durationSeconds: 18000, resetAt: now + 2.5 * hour };
const weekly = { usedPercent: 40, durationSeconds: 604800, resetAt: now + 84 * hour };
const rated = (window, rate) => ({ ...window, recentRate: { percentPerHour: rate, observedAt: now } });
const hint = (window, clock = now) => actionHint(window, budgetBalance(window, clock), clock);

test("budget warnings account for remaining time and a 20% planned-rate reduction", () => {
	assert.equal(budgetWarning({ ...weekly, usedPercent: 1, resetAt: now + 167.75 * hour }, now), false);
	assert.equal(budgetWarning({ ...weekly, usedPercent: 99, resetAt: now + 3 * hour }, now), true);
	for (const window of [weekly, fiveHour]) {
		assert.equal(budgetWarning(window, now), false); // Below budget.
		assert.equal(budgetWarning({ ...window, usedPercent: 50 }, now), false);
		assert.equal(budgetWarning({ ...window, usedPercent: 51 }, now), false);
		assert.equal(budgetWarning({ ...window, usedPercent: 59.9 }, now), false);
		assert.equal(budgetWarning({ ...window, usedPercent: 60 }, now), true); // Exactly a 20% reduction.
		assert.equal(budgetWarning({ ...window, usedPercent: 80 }, now), true);
		assert.equal(budgetWarning({ ...window, usedPercent: 100 }, now), true);
		assert.equal(budgetWarning(window, window.resetAt), false);
	}
	// Do not color a rounded B0% as an over-budget warning.
	assert.equal(budgetWarning({ ...fiveHour, usedPercent: 99.9, resetAt: now + 60_000 }, now), false);
});

test("C estimates time until exceeding budget, not time until exhausting allowance", () => {
	assert.equal(hint(rated(fiveHour, 30)), "(C≈1h)"); // 10-point spare budget / 10-point hourly overspend.
	assert.equal(hint(rated(weekly, 1)), "(C≈1d0h)");
	assert.equal(hint(rated(fiveHour, 20)), "(C≈2h30m)");
	assert.equal(hint(rated(fiveHour, 10)), "(C≈2h30m)"); // Never continue beyond the reset.
	assert.equal(hint(rated({ ...fiveHour, usedPercent: 50 }, 20)), "(C≈2h30m)");
});

test("S needs a measured rate above the planned pace; B0 alone does not imply stopping", () => {
	assert.equal(hint(rated({ ...fiveHour, usedPercent: 50 }, 30)), "(S)");
	assert.equal(hint({ ...fiveHour, usedPercent: 50 }), "(C≤2h30m)");
	assert.equal(hint(rated({ ...fiveHour, usedPercent: 49.75 }, 30)), "(S)");
});

test("P is calculable without history and means time to regain pace without usage", () => {
	assert.equal(hint({ ...fiveHour, usedPercent: 80 }), "(P≈1h30m)");
	assert.equal(hint({ ...weekly, usedPercent: 80 }), "(P≈2d2h)");
	assert.equal(hint({ ...fiveHour, usedPercent: 100 }), "(P≈2h30m)");
	assert.equal(hint({ ...weekly, usedPercent: 99, resetAt: now + (20 * 60 + 37) * 60_000 }), "(P≈18h57m)");
	const almostReset = { ...fiveHour, usedPercent: 100, resetAt: now + 10_000 };
	assert.equal(hint(almostReset), "(P≈<1m)");
	assert.equal(actionHint(fiveHour, -30, fiveHour.resetAt), undefined);
});

test("unknown, zero, invalid, or stale rates use a conditional horizon, not a measured forecast", () => {
	assert.equal(hint(fiveHour), "(C≤2h30m)");
	for (const rate of [0, -1, NaN, Infinity]) assert.equal(hint(rated(fiveHour, rate)), "(C≤2h30m)");
	assert.equal(hint({ ...fiveHour, recentRate: { percentPerHour: 30, observedAt: now - 11 * 60_000 } }), "(C≤2h30m)");
	assert.equal(hint({ ...weekly, usedPercent: 0, resetAt: now + 167 * hour }), "(C≤6d23h)");
	assert.equal(hint({ ...weekly, usedPercent: 0, resetAt: now + 167 * hour + 8 * 60_000 }), "(C≤6d23h)");
	assert.equal(hint({ ...fiveHour, usedPercent: 0, resetAt: now + 2 * hour + 15 * 60_000 }), "(C≤2h15m)");
	assert.equal(hint({ ...fiveHour, usedPercent: 0, resetAt: now + 30 * 60_000 }), "(C≤30m)");
	assert.equal(hint({ ...fiveHour, usedPercent: 0, resetAt: now + 5 * hour }), "(C≤5h)");
	assert.equal(hint({ ...fiveHour, recentRate: { percentPerHour: 30, observedAt: now + 60_000 } }), "(C≤2h30m)");
});

test("weekly hints retain rates for 30 minutes; five-hour hints retain them for 10", () => {
	for (const [window, rate, minutes] of [[weekly, 1, 30], [fiveHour, 30, 10]]) {
		const withAge = (age) => ({ ...window, recentRate: { percentPerHour: rate, observedAt: now - age } });
		assert.equal(hint(withAge(minutes * 60_000)), hint(rated(window, rate)));
		assert.match(hint(withAge(minutes * 60_000 + 1)), /^\(C≤/);
	}
});

test("weekly history tolerates unchanged readings longer than five-hour history", () => {
	const current = { weekly, fiveHour };
	const sample = (at, usedPercent) => ({ at, snapshot: {
		weekly: { ...weekly, usedPercent }, fiveHour: { ...fiveHour, usedPercent },
	} });
	const history = [sample(now - 30 * 60_000, 39), sample(now - 20 * 60_000, 40)];
	const result = withRecentRates(current, history, now);
	assert.equal(result.weekly.recentRate.percentPerHour, 2);
	assert.equal(result.weekly.recentRate.observedAt, now - 20 * 60_000);
	assert.match(hint(result.weekly), /^\(C≈/);
	assert.equal(result.fiveHour.recentRate, undefined);
	// A longer freshness limit does not bypass resets, corrections, or insufficient history.
	assert.equal(withRecentRates(current, [sample(now - 30 * 60_000, 41)], now).weekly.recentRate, undefined);
	const reset = sample(now - 30 * 60_000, 39);
	reset.snapshot.weekly.resetAt -= hour;
	assert.equal(withRecentRates(current, [reset], now).weekly.recentRate, undefined);
	assert.equal(withRecentRates(current, [sample(now - HISTORY_MS - 1, 39)], now).weekly.recentRate, undefined);
});

test("rates need five minutes of positive consumption and are shared across both limits", () => {
	const current = { weekly: { ...weekly, usedPercent: 40 }, fiveHour: { ...fiveHour, usedPercent: 40 } };
	const sample = (at, weeklyUsed, shortUsed) => ({ at, snapshot: {
		weekly: { ...weekly, usedPercent: weeklyUsed }, fiveHour: { ...fiveHour, usedPercent: shortUsed },
	} });
	assert.deepEqual(withRecentRates(current, [], now), current);
	assert.deepEqual(withRecentRates(current, [sample(now - 60_000, 39, 35)], now), current);
	const result = withRecentRates(current, [sample(now - 5 * 60_000, 39, 35)], now);
	assert.equal(result.weekly.recentRate.percentPerHour, 12);
	assert.equal(result.fiveHour.recentRate.percentPerHour, 60);
	assert.equal(result.weekly.recentRate.observedAt, now);
	assert.deepEqual(withRecentRates(current, [sample(now - 5 * 60_000, 40, 40)], now), current);
	assert.deepEqual(withRecentRates(current, [sample(now - HISTORY_MS - 1, 39, 35)], now), current);
});

test("resets, decreases, missing windows, and prolonged idle time invalidate rate history", () => {
	const current = { fiveHour };
	const older = (usedPercent, at = now - 10 * 60_000, resetAt = fiveHour.resetAt) => ({ at, snapshot: { fiveHour: { ...fiveHour, usedPercent, resetAt } } });
	assert.deepEqual(withRecentRates(current, [older(90)], now), current);
	assert.deepEqual(withRecentRates(current, [older(30, now - 10 * 60_000, now - hour)], now), current);
	assert.deepEqual(withRecentRates(current, [older(30), { at: now - 5 * 60_000, snapshot: { weekly } }], now), current);
	assert.deepEqual(withRecentRates(current, [older(30, now - 30 * 60_000), older(40, now - 20 * 60_000)], now), current);
});
