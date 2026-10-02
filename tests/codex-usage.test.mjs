import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(weekly), secondary_window: null } }, now), { weekly });
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(fiveHour), secondary_window: raw(weekly) } }, now), { weekly, fiveHour });
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(weekly), secondary_window: raw(fiveHour) } }, now), { weekly, fiveHour });
	assert.deepEqual(parseUsage({ rate_limit: { primary_window: raw(fiveHour), secondary_window: null } }, now), { fiveHour });
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
		assert.equal(budgetBalance(window, now), 0);
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

test("balance display rounds to whole points symmetrically and avoids signed zero", () => {
	for (const [value, text] of [[0, "B0%"], [10, "B+10%"], [-30, "B-30%"], [0.25, "B0%"], [-2.42857, "B-2%"], [1.5, "B+2%"], [-1.5, "B-2%"], [0.49, "B0%"], [-0.49, "B0%"], [0.5, "B+1%"], [-0.5, "B-1%"], [-0, "B0%"], [-100, "B-100%"]]) {
		assert.equal(displayBalance(value), text);
	}
});

const token = ["header", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url"), "sig"].join(".");
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
const plain = (text) => text?.replaceAll(/\[(?:warning|error)\]/g, "");

test("idle sessions share requests, update each minute, and explicitly redraw", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-extension-"));
	const original = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, now: Date.now, cache: process.env.XDG_CACHE_HOME };
	let clock = now;
	let requests = 0;
	let usedPercent = 40;
	let fail = false;
	const ticks = [];
	const sessions = [];
	process.env.XDG_CACHE_HOME = directory;
	Date.now = () => clock;
	globalThis.setInterval = (callback, ms) => {
		assert.equal(ms, 60_000);
		ticks.push(callback);
		return { unref() {} };
	};
	globalThis.fetch = async () => {
		requests++;
		return { ok: !fail, status: fail ? 503 : 200, json: async () => ({ rate_limit: {
			primary_window: raw({ ...weekly, usedPercent, resetAt: now + 3.5 * day }),
			secondary_window: raw({ usedPercent: 80, resetAt: now + 2.5 * 3_600_000, durationSeconds: 18000 }),
		} }) };
	};
	t.after(async () => {
		for (const { handlers, ctx } of sessions) handlers.get("session_shutdown")({}, ctx);
		globalThis.fetch = original.fetch;
		globalThis.setInterval = original.setInterval;
		Date.now = original.now;
		if (original.cache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = original.cache;
		await rm(directory, { recursive: true, force: true });
	});
	function session() {
		const handlers = new Map();
		extension({
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: () => assert.fail("No commands"),
			registerShortcut: () => assert.fail("No shortcuts"),
		});
		let widget;
		let renders = 0;
		const ctx = {
			mode: "tui", model: { provider: "openai-codex" }, isIdle: () => true,
			modelRegistry: { getApiKeyForProvider: async () => token },
			ui: {
				notify: () => assert.fail("No notifications"),
				setWidget: (_key, factory, options) => {
					if (factory) assert.equal(options.placement, "aboveEditor");
					widget = factory?.({ requestRender: () => renders++ }, { fg: (color, text) => color === "dim" ? text : `[${color}]${text}` });
				},
			},
		};
		const result = { handlers, ctx, status: () => widget?.render(120)[0].trimStart(), widget: () => widget, renders: () => renders };
		sessions.push(result);
		handlers.get("session_start")({}, ctx);
		assert.equal(handlers.has("message_end"), false); // Tool-heavy runs cannot trigger per-message fetches.
		assert.equal(handlers.has("agent_end"), false);
		assert.equal(handlers.has("agent_settled"), true);
		return result;
	}
	const first = session();
	assert.equal(first.widget(), undefined);
	await flush();
	assert.equal(first.status(), "W40% R3d12h B+10% • [warning]5H80% R2h30m [warning]B-30% (P≈1h30m)");
	assert.ok(first.widget().render(120)[0].startsWith(" "));
	assert.equal(plain(first.widget().render(12)[0]).length, 12);
	assert.equal(requests, 1);
	const second = session();
	await flush();
	assert.equal(second.status(), first.status());
	assert.equal(requests, 1); // Starting another idle session reuses the cache.
	for (let i = 0; i < 20; i++) first.handlers.get("agent_settled")({}, first.ctx);
	await flush();
	assert.equal(requests, 1); // A shared request already made at this work timestamp covers all these runs.
	const previousRenders = first.renders();
	clock += 60_000;
	for (const tick of ticks) tick();
	await flush();
	assert.equal(requests, 1);
	assert.equal(first.status(), second.status());
	assert.match(first.status(), /R3d11h/);
	assert.match(first.status(), /R2h29m/);
	assert.ok(first.renders() > previousRenders);
	usedPercent = 99;
	clock = now + 5 * 60_000;
	for (const tick of ticks) tick();
	await flush();
	assert.equal(requests, 2); // One request, not one per session, even while both are idle.
	for (const tick of ticks) tick(); // The non-fetching session picks up the newly written snapshot.
	await flush();
	assert.equal(first.status(), second.status());
	assert.match(first.status(), /^\[error\]W99% .*\[warning\]B-/);
	assert.equal(requests, 2);
	first.handlers.get("session_start")({}, first.ctx); // Reload/session reset uses the shared cache too.
	await flush();
	assert.equal(requests, 2);
	fail = true;
	clock += 5 * 60_000;
	for (const tick of ticks) tick();
	await flush();
	for (const tick of ticks) tick();
	await flush();
	assert.equal(requests, 3);
	assert.equal(first.widget(), undefined);
	assert.equal(second.widget(), undefined);
	clock += 60_000;
	for (const tick of ticks) tick();
	await flush();
	assert.equal(requests, 3); // Failed requests also observe the cooldown.
	fail = false;
	clock = now + 2.5 * 3_600_000;
	for (const tick of ticks) tick();
	await flush();
	for (const tick of ticks) tick();
	await flush();
	assert.equal(requests, 4);
	assert.match(plain(first.status()), /^W99% R\d+d\d+h B-\d+% \(P≈[^)]+\)$/); // Expired 5-hour limit is hidden.
	assert.equal(first.status(), second.status());
	clock = now + 3.5 * day;
	for (const tick of ticks) tick();
	await flush();
	for (const tick of ticks) tick();
	await flush();
	assert.equal(requests, 5);
	assert.equal(first.widget(), undefined); // Both expired: no placeholders or reserved row.
	assert.equal(second.widget(), undefined);
	first.ctx.model = { provider: "another" };
	first.handlers.get("model_select")({}, first.ctx);
	await flush();
	assert.equal(first.widget(), undefined);
	assert.equal(requests, 5);
});
