import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexAccountId, codexUsage } from "../lib/codex-rpc.ts";
import extension, { parseUsage } from "../extensions/codex-usage.ts";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-rpc-"));
	const keys = ["CODEX_HOME", "XDG_CACHE_HOME", "PATH", "FAKE_CODEX_MODE", "PI_OFFLINE"];
	const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.CODEX_HOME = join(directory, "auth");
	process.env.XDG_CACHE_HOME = join(directory, "cache");
	process.env.PATH = `${directory}:${process.env.PATH}`;
	delete process.env.FAKE_CODEX_MODE;
	delete process.env.PI_OFFLINE;
	await mkdir(process.env.CODEX_HOME);
	const authPath = join(process.env.CODEX_HOME, "auth.json");
	const saveAuth = (value) => writeFile(authPath, JSON.stringify(value));
	await saveAuth({ auth_mode: "chatgpt", tokens: { account_id: "cli-account" } });
	await writeFile(join(directory, "codex"), `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv.slice(2).join(' ') !== '-s read-only -a on-request app-server') process.exit(1);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') {
  send({method:'notification'});
  send({id:1,result:{}});
 }
 if (m.method === 'account/rateLimits/read') {
  const mode = process.env.FAKE_CODEX_MODE;
  if (mode === 'hang') return;
  if (mode === 'exit') return process.exit(1);
  if (mode === 'invalid') return process.stdout.write('not json\\n');
  if (mode === 'error') return send({id:2,error:{message:'do not leak this'}});
  if (mode === 'oversized') return process.stdout.write('x'.repeat(1100000));
  send({id:2,result:{accountId: mode === 'wrong-account' ? 'other-account' : 'cli-account',rateLimits:{
   primary:{usedPercent:40,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+302400},
   secondary:{usedPercent:80,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+9000}
  }}});
 }
});
`, { mode: 0o700 });
	t.after(async () => {
		for (const key of keys) {
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
		await rm(directory, { recursive: true, force: true });
	});
	return { saveAuth };
}

test("Codex identity respects CODEX_HOME and rejects API-key, missing, and malformed logins", async (t) => {
	const { saveAuth } = await fixture(t);
	assert.equal(await codexAccountId(), "cli-account");
	for (const value of [null, {}, { auth_mode: "apikey", tokens: { account_id: "cli-account" } },
		{ auth_mode: "chatgpt", tokens: { account_id: 123 } }, { auth_mode: "chatgpt", tokens: { account_id: "" } }]) {
		await saveAuth(value);
		assert.equal(await codexAccountId(), undefined);
	}
	await writeFile(join(process.env.CODEX_HOME, "auth.json"), "invalid");
	assert.equal(await codexAccountId(), undefined);
	await rm(join(process.env.CODEX_HOME, "auth.json"));
	assert.equal(await codexAccountId(), undefined);
});

test("read-only Codex RPC normalizes windows for the existing usage parser", async (t) => {
	await fixture(t);
	const snapshot = parseUsage(await codexUsage("cli-account", new AbortController().signal), Date.now());
	assert.equal(snapshot.weekly.usedPercent, 40);
	assert.equal(snapshot.weekly.durationSeconds, 604800);
	assert.equal(snapshot.fiveHour.usedPercent, 80);
	assert.equal(snapshot.fiveHour.durationSeconds, 18000);
});

test("Codex RPC rejects errors, account changes, malformed output, early exit, and excessive output", async (t) => {
	await fixture(t);
	for (const mode of ["error", "wrong-account", "invalid", "exit", "oversized"]) {
		process.env.FAKE_CODEX_MODE = mode;
		await assert.rejects(codexUsage("cli-account", new AbortController().signal));
	}
	process.env.FAKE_CODEX_MODE = "hang";
	await assert.rejects(codexUsage("cli-account", AbortSignal.timeout(100)), /cancelled/);
	await assert.rejects(codexUsage("cli-account", AbortSignal.abort()), /cancelled/);
	process.env.PATH = "/nonexistent";
	await assert.rejects(codexUsage("cli-account", new AbortController().signal), /unavailable/);
});

test("new OpenAI login preserves the existing display, shares cached data, and clears after logout", async (t) => {
	const { saveAuth } = await fixture(t);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => assert.fail("Do not send Pi's direct-API token to WHAM");
	const sessions = [];
	t.after(() => {
		for (const { handlers, ctx } of sessions) handlers.get("session_shutdown")({}, ctx);
		globalThis.fetch = originalFetch;
	});
	function session() {
		const handlers = new Map();
		extension({ on: (name, handler) => handlers.set(name, handler) });
		let widget;
		const ctx = {
			mode: "tui", model: { provider: "openai" },
			modelRegistry: {
				isUsingOAuth: () => true,
				getApiKeyForProvider: () => assert.fail("No Pi token needed for Codex RPC"),
			},
			ui: { setWidget: (_key, factory) => {
				widget = factory?.({ requestRender() {} }, { fg: (_color, text) => text });
			} },
		};
		const result = { handlers, ctx, status: () => widget?.render(150)[0].trimStart() };
		sessions.push(result);
		handlers.get("session_start")({}, ctx);
		return result;
	}
	const waitFor = async (condition) => {
		for (let i = 0; i < 100; i++) {
			if (condition()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail("Timed out waiting for widget");
	};
	const first = session();
	await waitFor(() => first.status()?.startsWith("W40%"));
	assert.match(first.status(), /5H80%/);
	// A broken RPC cannot affect a second session while the shared snapshot is fresh.
	process.env.FAKE_CODEX_MODE = "error";
	const second = session();
	await waitFor(() => second.status()?.startsWith("W40%"));
	assert.equal(second.status(), first.status());
	await saveAuth({ auth_mode: "apikey" });
	first.handlers.get("agent_settled")({}, first.ctx);
	await waitFor(() => first.status() === undefined);
	first.ctx.modelRegistry.isUsingOAuth = () => false;
	first.handlers.get("model_select")({}, first.ctx);
	assert.equal(first.status(), undefined); // API keys show no subscription widget.
});

test("usage widgets and requests remain terminal-only", async () => {
	for (const mode of ["print", "json", "rpc"]) {
		const handlers = new Map();
		extension({ on: (event, handler) => handlers.set(event, handler) });
		const ctx = {
			mode, model: { provider: "openai" },
			modelRegistry: { isUsingOAuth: () => assert.fail("No auth inspection outside TUI") },
			ui: { setWidget: () => assert.fail("No widget outside TUI") },
		};
		for (const name of ["session_start", "model_select", "agent_settled", "session_shutdown"]) {
			await handlers.get(name)({}, ctx);
		}
	}
});
