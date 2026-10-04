import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetBalance } from "../extensions/codex-usage.ts";
import { actionHint, budgetWarning, updateRecentRates } from "../lib/pacing.ts";

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

function tracker() {
	let previous;
	let comparisons = {};
	return (snapshot, at) => {
		const result = updateRecentRates(snapshot, previous, comparisons, at);
		previous = { at, snapshot: result.snapshot };
		comparisons = result.comparisons;
		return result;
	};
}
const both = (usedPercent) => ({ weekly: { ...weekly, usedPercent }, fiveHour: { ...fiveHour, usedPercent } });

test("compact comparisons retain weekly estimates longer than five-hour estimates", () => {
	const update = tracker();
	update(both(39), now - 25 * 60_000);
	update(both(40), now - 20 * 60_000);
	const result = update(both(40), now);
	assert.equal(result.snapshot.weekly.recentRate.percentPerHour, 12);
	assert.equal(result.snapshot.weekly.recentRate.observedAt, now - 20 * 60_000);
	assert.match(hint(result.snapshot.weekly), /^\(C≈/);
	assert.equal(result.snapshot.fiveHour.recentRate, undefined);
	assert.equal(update(both(40), now + 11 * 60_000).snapshot.weekly.recentRate, undefined);
});

test("rates accumulate frequent readings until five minutes of positive consumption", () => {
	const update = tracker();
	assert.deepEqual(update(both(35), now).snapshot, both(35));
	assert.deepEqual(update(both(36), now + 60_000).snapshot, both(36));
	update(both(37), now + 2 * 60_000);
	update(both(38), now + 3 * 60_000);
	update(both(39), now + 4 * 60_000);
	const result = update(both(40), now + 5 * 60_000);
	for (const key of ["weekly", "fiveHour"]) {
		assert.equal(result.snapshot[key].recentRate.percentPerHour, 60);
		assert.equal(result.snapshot[key].recentRate.observedAt, now + 5 * 60_000);
		assert.deepEqual(result.comparisons[key], { at: now + 5 * 60_000, usedPercent: 40, lastIncreaseAt: now + 5 * 60_000 });
	}
	// Unchanged readings retain the latest estimate, but do not refresh its observation time.
	const unchanged = update(both(40), now + 10 * 60_000);
	assert.deepEqual(unchanged.snapshot.weekly.recentRate, result.snapshot.weekly.recentRate);
	const next = update(both(41), now + 15 * 60_000);
	assert.equal(next.snapshot.weekly.recentRate.percentPerHour, 6); // Includes the idle gap.
});

test("resets, corrections, missing windows, clock rollback, and long gaps restart comparisons", () => {
	for (const change of [
		(previous) => { previous.snapshot.fiveHour.usedPercent = 90; },
		(previous) => { previous.snapshot.fiveHour.resetAt -= hour; },
		(previous) => { previous.snapshot.fiveHour.durationSeconds += 1; },
		(previous) => { previous.snapshot = { weekly }; },
		(previous) => { previous.at = now + 60_000; },
		(previous) => { previous.at = now - 31 * 60_000; },
	]) {
		const previous = { at: now - 5 * 60_000, snapshot: { fiveHour: rated({ ...fiveHour, usedPercent: 30 }, 20) } };
		change(previous);
		const result = updateRecentRates({ fiveHour }, previous, { fiveHour: { at: now - 5 * 60_000, usedPercent: 30 } }, now);
		assert.deepEqual(result.snapshot, { fiveHour });
		assert.deepEqual(result.comparisons, { fiveHour: { at: now, usedPercent: 40 } });
	}
	assert.deepEqual(updateRecentRates({}, { at: now - 60_000, snapshot: both(40) }, {}, now), { snapshot: {}, comparisons: {} });
});

test("old comparison points expire without losing the latest measurement", () => {
	const update = tracker();
	update(both(39), now - 40 * 60_000);
	update(both(39), now - 10 * 60_000);
	const result = update(both(40), now);
	assert.equal(result.snapshot.weekly.recentRate.percentPerHour, 6);
	assert.equal(result.snapshot.fiveHour.recentRate.percentPerHour, 6);
});
