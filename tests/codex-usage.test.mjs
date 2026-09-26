import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { countdown, pace, parseUsage } from "../extensions/codex-usage.ts";

const day = 86_400_000;
const now = Date.parse("2026-09-26T10:10:00Z");
const resetAt = Date.parse("2026-10-01T10:09:51Z");
const weekly = { usedPercent: 27, resetAt, durationSeconds: 604800 };

function raw(window) {
	return {
		used_percent: window.usedPercent,
		reset_at: window.resetAt / 1000,
		limit_window_seconds: window.durationSeconds,
	};
}

test("identifies weekly and optional 5-hour windows regardless of their order", () => {
	const fiveHour = { usedPercent: 82, resetAt: now + 2 * 3_600_000, durationSeconds: 18000 };
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(weekly), secondary_window: null } }, now), {
		weekly,
	});
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(fiveHour), secondary_window: raw(weekly) } }, now), {
		weekly,
		fiveHour,
	});
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(weekly), secondary_window: raw(fiveHour) } }, now), {
		weekly,
		fiveHour,
	});
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(fiveHour), secondary_window: null } }, now), {
		fiveHour,
	});
	assert.equal(parseUsage({ rate_limit: { primary_window: null, secondary_window: null } }, now), undefined);
	assert.equal(parseUsage({ rate_limit: { primary_window: { ...raw(fiveHour), reset_at: resetAt / 1000 } } }, now), undefined);
});

test("shows compact reset countdowns", () => {
	assert.equal(countdown(resetAt, now), "4d23h");
	assert.equal(countdown(now + 2 * 3_600_000 + 15 * 60_000, now), "2h15m");
	assert.equal(countdown(now + 9 * 60_000, now), "9m");
});

test("weekly pace uses rolling days and 5-hour pace uses rolling hours", () => {
	assert.ok(Math.abs(pace(weekly, now) - 14.6) < 0.3);
	assert.ok(pace(weekly, now + day) > pace(weekly, now));
	assert.ok(pace({ ...weekly, usedPercent: 32 }, now) < pace(weekly, now));
	assert.equal(pace(weekly, resetAt), undefined);
	assert.equal(pace({ ...weekly, usedPercent: 0, resetAt: now + day / 2 }, now), 200); // Only the display is capped.
	const fiveHour = { usedPercent: 82, resetAt: now + 2 * 3_600_000 + 15 * 60_000, durationSeconds: 18000 };
	assert.equal(pace(fiveHour, now, "hour"), 8); // 18 points left over 2.25 hours
	assert.equal(pace({ ...fiveHour, usedPercent: 10, resetAt: now + 30 * 60_000 }, now, "hour"), 180);
	assert.equal(pace(fiveHour, fiveHour.resetAt, "hour"), undefined);
});

const token = [
	"header",
	Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url"),
	"sig",
].join(".");
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 1_550));

test("right-aligns the widget, refreshes on activity, and colors usage only", async (t) => {
	const handlers = new Map();
	extension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: () => assert.fail("Extension must not add a command"),
		registerShortcut: () => assert.fail("Extension must not add a shortcut"),
	});
	let weeklyUsed = 31;
	let fiveHourUsed;
	let idle = true;
	let widget;
	let widgetUpdates = 0;
	let requests = 0;
	let failRequests = false;
	let tick;
	const weeklyResetAt = Date.now() + 5 * day;
	const fiveHourResetAt = Date.now() + 2 * 3_600_000;
	const originalFetch = globalThis.fetch;
	const originalSetInterval = globalThis.setInterval;
	const originalNow = Date.now;
	t.after(() => {
		globalThis.fetch = originalFetch;
		globalThis.setInterval = originalSetInterval;
		Date.now = originalNow;
	});
	globalThis.setInterval = (callback) => {
		tick = callback;
		return { unref() {} };
	};
	globalThis.fetch = async () => {
		requests++;
		if (failRequests) return { ok: false, status: 503 };
		return {
			ok: true,
			json: async () => ({
				rate_limit: {
					primary_window: raw({ ...weekly, usedPercent: weeklyUsed, resetAt: weeklyResetAt }),
					secondary_window: fiveHourUsed === undefined ? null : raw({ usedPercent: fiveHourUsed, resetAt: fiveHourResetAt, durationSeconds: 18000 }),
				},
			}),
		};
	};
	const theme = { fg: (color, text) => color === "dim" ? text : `[${color}]${text}` };
	const ctx = {
		mode: "tui",
		model: { provider: "openai-codex" },
		isIdle: () => idle,
		modelRegistry: { getApiKeyForProvider: async () => token },
		ui: {
			notify: () => assert.fail("Extension must not leave transcript notifications"),
			setWidget: (_key, factory, options) => {
				if (factory) assert.equal(options?.placement, "aboveEditor");
				widget = factory?.({}, theme);
				widgetUpdates++;
			},
		},
	};
	const status = () => widget?.render(120)[0].trimStart();
	t.after(() => handlers.get("session_shutdown")({}, ctx));

	handlers.get("session_start")({}, ctx);
	assert.deepEqual(widget?.render(120), [" ".repeat(120)]); // Reserve an empty row before the first fetch.
	await flush();
	assert.match(status(), /^W31% R\d+d\d+h D\d+\.\d%$/);
	assert.ok(widget.render(120)[0].startsWith(" "));
	assert.equal(widget.render(12)[0].length, 12);
	assert.equal(requests, 1);
	const firstWidgetUpdates = widgetUpdates;
	tick(); // A local tick neither rebuilds an unchanged widget nor fetches early.
	assert.equal(widgetUpdates, firstWidgetUpdates);
	assert.equal(requests, 1);
	Date.now = () => originalNow() + 11 * 60_000;
	tick(); // Even with a stale snapshot, an idle Pi must not fetch.
	assert.equal(requests, 1);
	idle = false;
	handlers.get("agent_start")({}, ctx); // Resume: fetch once when usage is stale.
	await flush();
	assert.equal(requests, 2);
	Date.now = originalNow;

	weeklyUsed = 71;
	fiveHourUsed = 82;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await flush();
	assert.equal(requests, 2); // Adjacent responses coalesce into one delayed request.
	await afterDebounce();
	assert.equal(requests, 3);
	assert.match(status(), /^\[warning\]W71% R\d+d\d+h D\d+\.\d% \[warning\]5H82% R\d+h\d+m H\d+\.\d%$/);
	assert.equal(widget.render(120)[0].replaceAll("[warning]", "").length, 120);
	assert.ok(widget.render(120)[0].startsWith(" ")); // Right-aligned at the available width.
	assert.equal(widget.render(12)[0].replaceAll("[warning]", "").length, 12);
	assert.equal(widget.render(7)[0].replaceAll("[warning]", "").length, 7);
	assert.match(widget.render(7)[0], /^\[warning\]W71%/); // Narrow terminals truncate to fit.

	weeklyUsed = 91;
	fiveHourUsed = 100;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce();
	assert.equal(requests, 4);
	assert.match(status(), /\[error\]W91% R\d+d\d+h D\d+\.\d% \[error\]5H100% R\d+h\d+m H0\.0%$/);
	handlers.get("message_end")({ message: { role: "user" } }, ctx);
	await flush();
	assert.equal(requests, 4);

	const lastWidgetUpdates = widgetUpdates;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce(); // An unchanged response fetches but doesn't rebuild the widget.
	assert.equal(requests, 5);
	assert.equal(widgetUpdates, lastWidgetUpdates);

	idle = true;
	Date.now = () => fiveHourResetAt + 1_000;
	tick(); // An expired idle window is unknown, not the old used percentage.
	assert.match(status(), /5H\?$/);
	assert.equal(requests, 5);
	Date.now = originalNow;

	weeklyUsed = 31;
	fiveHourUsed = 10;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce();
	assert.match(status(), /^W31% R\d+d\d+h D\d+\.\d% 5H10% R\d+h\d+m H\d+\.\d%$/);
	Date.now = () => fiveHourResetAt - 30 * 60_000;
	tick();
	assert.match(status(), /5H10% R30m H100\.0%$/); // 180%/h is capped at 100%/h.
	Date.now = () => weeklyResetAt - day / 2;
	tick();
	assert.match(status(), /^W31% R12h0m D100\.0% 5H\?$/); // 138%/d is capped at 100%/d.
	Date.now = () => weeklyResetAt + 1_000;
	tick();
	assert.equal(status(), "W? 5H?"); // Never treat an expired weekly window as current.
	Date.now = originalNow;

	failRequests = true;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce();
	assert.deepEqual(widget?.render(120), [" ".repeat(120)]); // Failures keep the row but not stale data.

	ctx.model = { provider: "another" };
	handlers.get("model_select")({}, ctx);
	assert.equal(widget, undefined);
});
