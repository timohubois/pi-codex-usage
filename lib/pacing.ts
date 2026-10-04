import type { UsageSnapshot, UsageWindow } from "../extensions/codex-usage.ts";

const MAX_COMPARISON_MS = 30 * 60_000;
const MIN_SAMPLE_MS = 5 * 60_000;
function rateMaxAge(window: UsageWindow): number {
	// Weekly readings can stay unchanged during active use due to whole-percent rounding.
	return window.durationSeconds >= 6 * 86_400 && window.durationSeconds <= 8 * 86_400
		? 30 * 60_000
		: 10 * 60_000;
}
export type UsageSample = { at: number; snapshot: UsageSnapshot };
export type RateComparison = { at: number; usedPercent: number; lastIncreaseAt?: number };
export type RateComparisons = Partial<Record<keyof UsageSnapshot, RateComparison>>;

function usableRate(window: UsageWindow, now: number): boolean {
	const rate = window.recentRate;
	return !!rate && Number.isFinite(rate.percentPerHour) && rate.percentPerHour > 0 &&
		Number.isFinite(rate.observedAt) && rate.observedAt <= now && now - rate.observedAt <= rateMaxAge(window);
}

/** Keep one comparison per limit instead of a measurement history. Rates include account-wide idle time. */
export function updateRecentRates(
	snapshot: UsageSnapshot,
	previous: UsageSample | undefined,
	comparisons: RateComparisons,
	now: number,
): { snapshot: UsageSnapshot; comparisons: RateComparisons } {
	const result: UsageSnapshot = {};
	const next: RateComparisons = {};
	for (const key of ["weekly", "fiveHour"] as const) {
		const window = snapshot[key];
		if (!window) continue;
		const { recentRate: _oldRate, ...raw } = window;
		result[key] = raw;
		next[key] = { at: now, usedPercent: window.usedPercent };
		const older = previous?.snapshot[key];
		if (!previous || !older || !Number.isFinite(previous.at) || previous.at >= now ||
			now - previous.at > MAX_COMPARISON_MS || older.durationSeconds !== window.durationSeconds ||
			Math.abs(older.resetAt - window.resetAt) > 60_000 || older.usedPercent > window.usedPercent) continue;

		let comparison = comparisons[key];
		if (!comparison || !Number.isFinite(comparison.at) || comparison.at > previous.at ||
			now - comparison.at > MAX_COMPARISON_MS || !Number.isFinite(comparison.usedPercent) ||
			comparison.usedPercent < 0 || comparison.usedPercent > older.usedPercent) {
			comparison = { at: previous.at, usedPercent: older.usedPercent };
		}
		const lastIncreaseAt = window.usedPercent > older.usedPercent ? now : comparison.lastIncreaseAt;
		next[key] = { ...comparison, lastIncreaseAt };
		// Reuse the last estimate until a new interval has enough time and positive consumption.
		if (usableRate(older, now)) result[key] = { ...raw, recentRate: older.recentRate };
		const elapsed = now - comparison.at;
		const increase = window.usedPercent - comparison.usedPercent;
		if (elapsed < MIN_SAMPLE_MS || increase <= 0 || lastIncreaseAt === undefined ||
			!Number.isFinite(lastIncreaseAt) || lastIncreaseAt > now || now - lastIncreaseAt > rateMaxAge(window)) continue;
		result[key] = { ...raw, recentRate: { percentPerHour: increase * 3_600_000 / elapsed, observedAt: lastIncreaseAt } };
		// Start the next comparison interval; storage stays constant regardless of request frequency.
		next[key] = { at: now, usedPercent: window.usedPercent, lastIncreaseAt };
	}
	return { snapshot: result, comparisons: next };
}

function hintTime(milliseconds: number, roundUp: boolean): string {
	if (milliseconds < 60_000) return "<1m";
	const total = roundUp ? Math.ceil(milliseconds / 60_000) : Math.floor(milliseconds / 60_000);
	const days = Math.floor(total / 1440);
	const hours = Math.floor(total % 1440 / 60);
	const minutes = total % 60;
	if (days) return `${days}d${hours}h`;
	if (hours) return `${hours}h${minutes ? `${minutes}m` : ""}`;
	return `${minutes}m`;
}

/** Warn about a meaningful reduction from the evenly planned rate, not every small deficit. */
export function budgetWarning(window: UsageWindow, now: number): boolean {
	const remaining = window.resetAt - now;
	if (remaining <= 0) return false;
	const plannedRemaining = Math.min(100, remaining / (window.durationSeconds * 1000) * 100);
	const actualRemaining = Math.max(0, 100 - window.usedPercent);
	const deficit = plannedRemaining - actualRemaining;
	if (deficit <= 0 || Math.round(deficit) === 0) return false;
	return deficit >= plannedRemaining * 0.2;
}

export function actionHint(window: UsageWindow, balance: number, now: number): string | undefined {
	const remaining = window.resetAt - now;
	if (remaining <= 0) return undefined;
	const baseline = 100 * 3_600_000 / (window.durationSeconds * 1000);
	const rounded = Math.round(Math.abs(balance));
	if ((balance < 0 && rounded > 0) || window.usedPercent >= 100) {
		const pause = Math.min(remaining, Math.max(0, -balance) * window.durationSeconds * 1000 / 100);
		return `(P≈${hintTime(pause, true)})`;
	}
	const rate = window.recentRate;
	if (!rate || !usableRate(window, now)) {
		// A conditional reset horizon, not an observed-rate forecast.
		return `(C≤${hintTime(remaining, false)})`;
	}
	if (rate.percentPerHour > baseline && rounded === 0) return "(S)";
	const untilBudget = rate.percentPerHour > baseline ? balance / (rate.percentPerHour - baseline) * 3_600_000 : remaining;
	const untilExhausted = (100 - window.usedPercent) / rate.percentPerHour * 3_600_000;
	const duration = Math.max(0, Math.min(remaining, untilBudget, untilExhausted));
	return `(C≈${hintTime(duration, false)})`;
}
