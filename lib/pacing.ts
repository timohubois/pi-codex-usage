import type { UsageSnapshot, UsageWindow } from "../extensions/codex-usage.ts";

export const HISTORY_MS = 30 * 60_000;
const MIN_SAMPLE_MS = 5 * 60_000;
const RATE_MAX_AGE_MS = 10 * 60_000;
export type UsageSample = { at: number; snapshot: UsageSnapshot };

/** Rates are account-wide allowance consumption over wall-clock time, not tokens or guaranteed work time. */
export function withRecentRates(snapshot: UsageSnapshot, history: UsageSample[], now: number): UsageSnapshot {
	const result: UsageSnapshot = {};
	for (const key of ["weekly", "fiveHour"] as const) {
		const window = snapshot[key];
		if (!window) continue;
		const { recentRate: _oldRate, ...raw } = window;
		result[key] = raw;
		const samples = history.filter((sample) => Number.isFinite(sample.at) && sample.at <= now && now - sample.at <= HISTORY_MS);
		let oldest: UsageSample | undefined;
		let previousUsed = window.usedPercent;
		let previousAt = now;
		let lastIncreaseAt: number | undefined;
		// Walk back only through the uninterrupted current window; resets and usage corrections break the chain.
		for (let i = samples.length - 1; i >= 0; i--) {
			const sample = samples[i];
			const older = sample.snapshot[key];
			if (sample.at >= previousAt) continue;
			if (!older) break;
			if (older.durationSeconds !== window.durationSeconds || Math.abs(older.resetAt - window.resetAt) > 60_000 || older.usedPercent > previousUsed) break;
			if (lastIncreaseAt === undefined && older.usedPercent < previousUsed) lastIncreaseAt = previousAt;
			oldest = sample;
			previousUsed = older.usedPercent;
			previousAt = sample.at;
		}
		if (!oldest || lastIncreaseAt === undefined || now - lastIncreaseAt > RATE_MAX_AGE_MS) continue;
		const elapsed = now - oldest.at;
		const increase = window.usedPercent - oldest.snapshot[key]!.usedPercent;
		if (elapsed < MIN_SAMPLE_MS || increase <= 0) continue;
		result[key] = { ...raw, recentRate: { percentPerHour: increase * 3_600_000 / elapsed, observedAt: lastIncreaseAt } };
	}
	return result;
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
	if (!rate || !Number.isFinite(rate.percentPerHour) || rate.percentPerHour <= 0 ||
		!Number.isFinite(rate.observedAt) || now < rate.observedAt || now - rate.observedAt > RATE_MAX_AGE_MS) {
		// A conditional reset horizon, not an observed-rate forecast.
		return `(C≤${hintTime(remaining, false)})`;
	}
	if (rate.percentPerHour > baseline && rounded === 0) return "(S)";
	const untilBudget = rate.percentPerHour > baseline ? balance / (rate.percentPerHour - baseline) * 3_600_000 : remaining;
	const untilExhausted = (100 - window.usedPercent) / rate.percentPerHour * 3_600_000;
	const duration = Math.max(0, Math.min(remaining, untilBudget, untilExhausted));
	return `(C≈${hintTime(duration, false)})`;
}
