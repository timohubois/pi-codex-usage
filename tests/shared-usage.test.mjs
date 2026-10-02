import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { POLL_MS, sharedUsage } from "../lib/shared-usage.ts";

const snapshot = { weekly: { usedPercent: 40, resetAt: 2_000_000_000_000, durationSeconds: 604800 } };
async function temporary(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-cache-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("shares successful usage, isolates accounts, and throttles failures", async (t) => {
	const directory = await temporary(t);
	const start = Date.now();
	let requests = 0;
	const fetchUsage = async () => { requests++; return snapshot; };
	const options = (offset = 0) => ({ directory, now: start + offset });
	assert.deepEqual(await sharedUsage("account-one", fetchUsage, options()), snapshot);
	assert.deepEqual(await sharedUsage("account-one", fetchUsage, options(60_000)), snapshot);
	assert.equal(requests, 1);
	assert.deepEqual(await sharedUsage("account-two", fetchUsage, options()), snapshot);
	assert.equal(requests, 2);
	assert.deepEqual(await sharedUsage("account-one", fetchUsage, options(POLL_MS)), snapshot);
	assert.equal(requests, 3);
	const failed = async () => { requests++; throw new Error("HTTP 503"); };
	assert.equal(await sharedUsage("account-one", failed, options(2 * POLL_MS)), undefined);
	assert.equal(await sharedUsage("account-one", fetchUsage, options(2 * POLL_MS + 60_000)), undefined);
	assert.equal(requests, 4);
	assert.deepEqual(await sharedUsage("account-one", fetchUsage, options(3 * POLL_MS)), snapshot);
	assert.equal(requests, 5);
	for (const filename of await readdir(directory)) {
		assert.match(filename, /^[a-f0-9]{64}\.json$/);
		assert.doesNotMatch(await readFile(join(directory, filename), "utf8"), /account-one|account-two|Bearer/);
	}
});

test("concurrent OS processes make only one request", async (t) => {
	const directory = await temporary(t);
	const counter = join(directory, "requests");
	const module = new URL("../lib/shared-usage.ts", import.meta.url).href;
	const script = `
		import { appendFile } from 'node:fs/promises';
		import { sharedUsage } from ${JSON.stringify(module)};
		await sharedUsage('same-account', async () => {
			await appendFile(${JSON.stringify(counter)}, 'request\\n');
			await new Promise(resolve => setTimeout(resolve, 150));
			return ${JSON.stringify(snapshot)};
		}, { directory: ${JSON.stringify(directory)} });
	`;
	await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script])));
	assert.equal(await readFile(counter, "utf8"), "request\n");
	assert.deepEqual(await sharedUsage("same-account", async () => assert.fail("Must reuse cache"), { directory }), snapshot);
});

test("recovers abandoned locks and corrupt cache, without falling back to uncoordinated requests", async (t) => {
	const directory = await temporary(t);
	const key = createHash("sha256").update("account").digest("hex");
	const path = join(directory, `${key}.json`);
	const lock = join(directory, `${key}.lock`);
	await writeFile(path, "not-json");
	await mkdir(lock);
	const stale = new Date(Date.now() - 120_000);
	await utimes(lock, stale, stale);
	let requests = 0;
	const fetchUsage = async () => { requests++; return snapshot; };
	assert.equal(await sharedUsage("account", fetchUsage, { directory }), undefined); // Remove stale lock, retry next tick.
	assert.equal(requests, 0);
	assert.deepEqual(await sharedUsage("account", fetchUsage, { directory }), snapshot);
	assert.equal(requests, 1);
	const blocked = join(directory, "not-a-directory");
	await writeFile(blocked, "blocked");
	assert.equal(await sharedUsage("account", fetchUsage, { directory: blocked }), undefined);
	assert.equal(requests, 1);
});

test("in-flight requests do not leave a fresh-looking old snapshot forever", async (t) => {
	const directory = await temporary(t);
	const key = createHash("sha256").update("account").digest("hex");
	const clock = Date.now();
	await writeFile(join(directory, `${key}.json`), JSON.stringify({
		attemptedAt: clock, fetchedAt: clock - 10 * 60_000, snapshot,
	}));
	assert.equal(await sharedUsage("account", async () => assert.fail("Still in cooldown"), { directory, now: clock }), undefined);
});

test("recent rates are persisted and reused across sessions without extra requests", async (t) => {
	const directory = await temporary(t);
	const start = Date.now();
	let requests = 0;
	const short = { usedPercent: 37.5, resetAt: start + 3_600_000, durationSeconds: 18000 };
	await sharedUsage("account", async () => { requests++; return { fiveHour: short }; }, { directory, now: start });
	const fetched = await sharedUsage("account", async () => {
		requests++;
		return { fiveHour: { ...short, usedPercent: 40 } };
	}, { directory, now: start + POLL_MS });
	assert.equal(fetched.fiveHour.recentRate.percentPerHour, 30);
	const reused = await sharedUsage("account", async () => assert.fail("Must reuse shared history"), { directory, now: start + POLL_MS + 60_000 });
	assert.deepEqual(reused, fetched);
	assert.equal(requests, 2);
	const [filename] = await readdir(directory);
	const cache = JSON.parse(await readFile(join(directory, filename), "utf8"));
	assert.equal(cache.history.length, 2);
});
