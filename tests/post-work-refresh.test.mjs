import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import extension from "../extensions/codex-usage.ts";
import { POLL_MS, sharedUsage, WORK_COOLDOWN_MS } from "../lib/shared-usage.ts";

const snapshot = { weekly: { usedPercent: 40, resetAt: 2_000_000_000_000, durationSeconds: 604800 } };

test("post-work requests defer, coalesce across sessions, and leave quiet polling at five minutes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-work-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const start = Date.now();
	let requests = 0;
	const fetchUsage = async () => { requests++; return snapshot; };
	const options = (offset, workOffset) => ({ directory, now: start + offset, afterWorkAt: workOffset === undefined ? undefined : start + workOffset });
	await sharedUsage("account", fetchUsage, options(0));
	let delay;
	await sharedUsage("account", fetchUsage, { ...options(30_000, 30_000), onDeferred: (ms) => delay = ms });
	assert.equal(delay, 30_000);
	assert.equal(requests, 1);
	await sharedUsage("account", fetchUsage, options(WORK_COOLDOWN_MS, 30_000));
	assert.equal(requests, 2);
	await sharedUsage("account", fetchUsage, { ...options(WORK_COOLDOWN_MS, 30_000), onDeferred: () => assert.fail("Other session's fetch already covers this work") });
	assert.equal(requests, 2);
	await sharedUsage("account", fetchUsage, options(2 * WORK_COOLDOWN_MS));
	assert.equal(requests, 2); // Quiet ticks cannot use the shorter post-work cooldown.
	await sharedUsage("account", fetchUsage, options(WORK_COOLDOWN_MS + POLL_MS));
	assert.equal(requests, 3);
	await sharedUsage("account", fetchUsage, { ...options(WORK_COOLDOWN_MS + POLL_MS + 30_000, WORK_COOLDOWN_MS + POLL_MS + 30_000), onDeferred: (ms) => delay = ms });
	assert.equal(delay, 30_000);
	const failed = async () => { requests++; throw new Error("503"); };
	assert.equal(await sharedUsage("account", failed, options(2 * WORK_COOLDOWN_MS + POLL_MS, WORK_COOLDOWN_MS + POLL_MS + 30_000)), undefined);
	assert.equal(requests, 4);
	assert.equal(await sharedUsage("account", fetchUsage, { ...options(2 * WORK_COOLDOWN_MS + POLL_MS + 10_000, 2 * WORK_COOLDOWN_MS + POLL_MS + 10_000), onDeferred: (ms) => delay = ms }), undefined);
	assert.equal(delay, 50_000);
	assert.equal(requests, 4); // Failures do not bypass the one-minute cooldown.
});

test("settled runs schedule one deferred refresh, reuse other sessions, and cancel timers on shutdown", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-deferred-"));
	const original = { cache: process.env.XDG_CACHE_HOME, fetch: globalThis.fetch, interval: globalThis.setInterval, timeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
	const start = Date.now();
	let clock = start;
	let requests = 0;
	const timers = new Set();
	const ticks = [];
	const sessions = [];
	process.env.XDG_CACHE_HOME = directory;
	Date.now = () => clock;
	globalThis.setInterval = (callback) => { ticks.push(callback); return { unref() {} }; };
	globalThis.setTimeout = (callback, ms) => {
		const timer = { callback, due: clock + ms, unref() {} };
		timers.add(timer);
		return timer;
	};
	globalThis.clearTimeout = (timer) => timers.delete(timer);
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "work-account" } })).toString("base64url")}.sig`;
	globalThis.fetch = async () => {
		requests++;
		return { ok: true, json: async () => ({ rate_limit: { primary_window: {
			used_percent: 40, limit_window_seconds: 604800, reset_at: (start + 3.5 * 86_400_000) / 1000,
		} } }) };
	};
	t.after(async () => {
		for (const session of sessions) session.handlers.get("session_shutdown")({}, session.ctx);
		globalThis.fetch = original.fetch;
		globalThis.setInterval = original.interval;
		globalThis.setTimeout = original.timeout;
		globalThis.clearTimeout = original.clearTimeout;
		Date.now = original.now;
		if (original.cache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = original.cache;
		await rm(directory, { recursive: true, force: true });
	});
	function session() {
		const handlers = new Map();
		extension({ on: (name, handler) => handlers.set(name, handler) });
		const ctx = { mode: "tui", model: { provider: "openai-codex" }, modelRegistry: { getApiKeyForProvider: async () => token }, ui: { setWidget() {} } };
		const result = { handlers, ctx };
		sessions.push(result);
		handlers.get("session_start")({}, ctx);
		return result;
	}
	const first = session();
	await wait(50);
	const second = session();
	await wait(50);
	assert.equal(requests, 1);
	clock = start + 30_000;
	for (const session of sessions) session.handlers.get("agent_settled")({}, session.ctx);
	await wait(50);
	assert.equal(requests, 1);
	assert.equal(timers.size, 2); // Each process may schedule locally; the disk lock coalesces network requests.
	for (const timer of timers) assert.equal(timer.due, start + 60_000);
	// Another session requests at the cooldown boundary before these delayed callbacks run.
	clock = start + 60_000;
	second.handlers.get("agent_settled")({}, second.ctx);
	await wait(50);
	assert.equal(requests, 2);
	for (const timer of [...timers]) {
		assert.ok(timer.due <= clock);
		timers.delete(timer);
		timer.callback();
	}
	await wait(50);
	assert.equal(requests, 2); // Queued work is already covered, so it does not request or reschedule.
	assert.equal(timers.size, 0);
	clock = start + 90_000;
	for (const session of sessions) session.handlers.get("agent_settled")({}, session.ctx);
	await wait(50);
	assert.equal(timers.size, 2);
	first.handlers.get("model_select")({}, { ...first.ctx, model: { provider: "another" } });
	second.handlers.get("session_shutdown")({}, second.ctx);
	assert.equal(timers.size, 0);
	assert.equal(requests, 2);
});
