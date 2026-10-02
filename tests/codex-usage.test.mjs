import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { budgetBalance, countdown, displayBalance, parseUsage } from "../extensions/codex-usage.ts";

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

test("both windows compare usage with elapsed allowance", () => {
	for (const durationSeconds of [604800, 18000, 14400]) {
		const duration = durationSeconds * 1000;
		const window = { usedPercent: 0, resetAt: now + duration, durationSeconds };
		assert.equal(budgetBalance(window, now), 0); // Full reset.
		assert.equal(budgetBalance(window, now - 1_000), 0); // Clamp clock skew before the start.
		assert.equal(budgetBalance({ ...window, usedPercent: 40 }, now + duration / 2), 10);
		assert.equal(budgetBalance({ ...window, usedPercent: 50 }, now + duration / 2), 0);
		assert.equal(budgetBalance({ ...window, usedPercent: 80 }, now + duration / 2), -30);
		assert.equal(budgetBalance({ ...window, usedPercent: 60 }, now + duration * 0.75), 15);
		assert.equal(budgetBalance({ ...window, usedPercent: 100 }, now), -100);
		assert.equal(budgetBalance(window, window.resetAt), undefined);
		assert.equal(budgetBalance(window, window.resetAt + 1_000), undefined);
	}
});

test("balance display has a sign, up to two decimals, and no signed zero", () => {
	assert.equal(displayBalance(0), "B0%");
	assert.equal(displayBalance(10), "B+10%");
	assert.equal(displayBalance(-30), "B-30%");
	assert.equal(displayBalance(0.25), "B+0.25%");
	assert.equal(displayBalance(-2.42857), "B-2.43%");
	assert.equal(displayBalance(1.5), "B+1.5%");
	assert.equal(displayBalance(0.004), "B0%");
	assert.equal(displayBalance(-0.004), "B0%");
	assert.equal(displayBalance(-0), "B0%");
	assert.equal(displayBalance(-100), "B-100%");
});

const token = [
	"header",
	Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url"),
	"sig",
].join(".");
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 1_550));

test("right-aligns the widget, refreshes on activity, and warns about negative balances", async (t) => {
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
	const originalFetch = globalThis.fetch;
	const originalSetInterval = globalThis.setInterval;
	const originalNow = Date.now;
	const baseNow = originalNow();
	Date.now = () => baseNow; // Keep balance rounding stable across asynchronous requests.
	let weeklyResetAt = baseNow + 5 * day;
	const fiveHourResetAt = baseNow + 2 * 3_600_000;
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
	assert.equal(widget, undefined); // No reserved row while usage is loading.
	await flush();
	assert.equal(status(), "W31% R5d0h [warning]B-2.43%");
	assert.ok(widget.render(120)[0].startsWith(" "));
	assert.equal(widget.render(12)[0].replaceAll("[warning]", "").length, 12);
	assert.equal(requests, 1);
	const firstWidgetUpdates = widgetUpdates;
	tick(); // A local tick neither rebuilds an unchanged widget nor fetches early.
	assert.equal(widgetUpdates, firstWidgetUpdates);
	assert.equal(requests, 1);
	Date.now = () => baseNow + 11 * 60_000;
	tick(); // Even with a stale snapshot, an idle Pi must not fetch.
	assert.equal(requests, 1);
	idle = false;
	handlers.get("agent_start")({}, ctx); // Resume: fetch once when usage is stale.
	await flush();
	assert.equal(requests, 2);
	Date.now = () => baseNow;

	weeklyUsed = 71;
	fiveHourUsed = 82;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await flush();
	assert.equal(requests, 2); // Adjacent responses coalesce into one delayed request.
	await afterDebounce();
	assert.equal(requests, 3);
	assert.equal(status(), "[warning]W71% R5d0h [warning]B-42.43% [warning]5H82% R2h0m [warning]B-22%");
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
	assert.equal(status(), "[error]W91% R5d0h [warning]B-62.43% [error]5H100% R2h0m [warning]B-40%");
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
	tick(); // Hide an expired idle window without hiding the valid weekly window.
	assert.match(status(), /^\[error\]W91% R\d+d\d+h \[warning\]B-\d+(?:\.\d+)?%$/);
	assert.equal(requests, 5);
	Date.now = () => baseNow;

	weeklyUsed = 31;
	fiveHourUsed = 10;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce();
	assert.equal(status(), "W31% R5d0h [warning]B-2.43% 5H10% R2h0m B+50%");
	Date.now = () => fiveHourResetAt - 30 * 60_000;
	tick();
	assert.match(status(), /5H10% R30m B\+80%$/);
	Date.now = () => weeklyResetAt - day / 2;
	tick();
	assert.equal(status(), "W31% R12h0m B+61.86%"); // The expired 5-hour window is omitted.
	Date.now = () => weeklyResetAt + 1_000;
	tick();
	assert.equal(widget, undefined); // Hide the row when both windows have expired.
	Date.now = () => baseNow;

	weeklyResetAt = baseNow - 1_000;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce();
	assert.equal(status(), "5H10% R2h0m B+50%"); // A valid 5-hour window stands alone.

	failRequests = true;
	handlers.get("message_end")({ message: { role: "assistant" } }, ctx);
	await afterDebounce();
	assert.equal(widget, undefined); // Failures hide the row rather than leaving stale data.

	ctx.model = { provider: "another" };
	handlers.get("model_select")({}, ctx);
	assert.equal(widget, undefined);
});
