import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "../extensions/codex-usage.ts";
import { updateRecentRates, type RateComparisons } from "./pacing.ts";

export const POLL_MS = 5 * 60_000;
export const WORK_COOLDOWN_MS = 60_000;
const LOCK_MS = 60_000; // Longer than the usage request timeout.
const MAX_AGE_MS = POLL_MS + 60_000;
type CacheRecord = {
	attemptedAt: number;
	fetchedAt?: number;
	snapshot?: UsageSnapshot;
	comparisons?: RateComparisons;
	needsMigration?: boolean;
};

export function cacheDirectory(): string {
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-codex-usage");
}

function validWindow(window: UsageWindow): boolean {
	return !!window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
		Number.isFinite(window.resetAt) && Number.isFinite(window.durationSeconds) && window.durationSeconds > 0;
}

function validSnapshot(snapshot: UsageSnapshot): boolean {
	return !!snapshot && typeof snapshot === "object" && !!(snapshot.weekly || snapshot.fiveHour) &&
		(!snapshot.weekly || validWindow(snapshot.weekly)) && (!snapshot.fiveHour || validWindow(snapshot.fiveHour));
}

async function readCache(path: string): Promise<CacheRecord | undefined> {
	try {
		const record = JSON.parse(await readFile(path, "utf8")) as CacheRecord;
		if (!record || !Number.isFinite(record.attemptedAt)) return undefined;
		if (record.snapshot && (!Number.isFinite(record.fetchedAt) || !validSnapshot(record.snapshot))) return undefined;
		const comparisons: RateComparisons = {};
		for (const key of ["weekly", "fiveHour"] as const) {
			const comparison = record.comparisons?.[key];
			if (!comparison || record.fetchedAt === undefined || !record.snapshot?.[key] ||
				!Number.isFinite(comparison.at) || comparison.at > record.fetchedAt ||
				!Number.isFinite(comparison.usedPercent) || comparison.usedPercent < 0 ||
				comparison.usedPercent > record.snapshot[key]!.usedPercent) continue;
			const lastIncreaseAt = comparison.lastIncreaseAt;
			comparisons[key] = {
				at: comparison.at, usedPercent: comparison.usedPercent,
				lastIncreaseAt: lastIncreaseAt !== undefined && Number.isFinite(lastIncreaseAt) && lastIncreaseAt <= record.fetchedAt
					? lastIncreaseAt : undefined,
			};
		}
		// Drop legacy histories without reading or copying their individual measurements.
		return {
			attemptedAt: record.attemptedAt, fetchedAt: record.fetchedAt, snapshot: record.snapshot, comparisons,
			needsMigration: Object.hasOwn(record, "history"),
		};
	} catch {
		return undefined;
	}
}

function cachedSnapshot(record: CacheRecord | undefined, now: number, onFetchedAt?: (at: number) => void): UsageSnapshot | undefined {
	if (!record?.snapshot || record.fetchedAt === undefined || now < record.fetchedAt || now - record.fetchedAt > MAX_AGE_MS) {
		return undefined;
	}
	onFetchedAt?.(record.fetchedAt);
	return record.snapshot;
}

async function saveCache(path: string, record: CacheRecord): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const { needsMigration: _migration, ...stored } = record;
		await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Coordinate all sessions on this machine without storing OAuth credentials. */
export async function sharedUsage(
	accountId: string,
	fetchUsage: () => Promise<UsageSnapshot>,
	options: {
		directory?: string;
		now?: number;
		afterWorkAt?: number;
		onDeferred?: (delayMs: number) => void;
		/** Measurement time, preserved when another session reuses the cached snapshot. */
		onFetchedAt?: (at: number) => void;
	} = {},
): Promise<UsageSnapshot | undefined> {
	const directory = options.directory ?? cacheDirectory();
	const now = options.now ?? Date.now();
	const key = createHash("sha256").update(accountId).digest("hex");
	const path = join(directory, `${key}.json`);
	const lock = join(directory, `${key}.lock`);
	let ownsLock = false;
	function reuse(record: CacheRecord | undefined): boolean {
		if (!record) return false;
		const coversWork = options.afterWorkAt !== undefined && record.attemptedAt >= options.afterWorkAt;
		const cooldown = options.afterWorkAt === undefined || coversWork ? POLL_MS : WORK_COOLDOWN_MS;
		const age = now - record.attemptedAt;
		if (age < 0 || age >= cooldown) return false;
		if (options.afterWorkAt !== undefined && !coversWork) options.onDeferred?.(cooldown - age);
		return true;
	}
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		let record = await readCache(path);
		if (reuse(record) && !record?.needsMigration) return cachedSnapshot(record, now, options.onFetchedAt);
		try {
			await mkdir(lock, { mode: 0o700 });
			ownsLock = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A killed session must not leave all other sessions permanently locked out.
			if (now - (await stat(lock)).mtimeMs > LOCK_MS) await rm(lock, { recursive: true, force: true });
			const latest = await readCache(path);
			if (!reuse(latest) && options.afterWorkAt !== undefined) options.onDeferred?.(1_000);
			return cachedSnapshot(latest, now, options.onFetchedAt); // Background readers retry on the next tick.
		}
		// Another process may have updated the cache between our first read and acquisition.
		record = await readCache(path);
		if (record?.needsMigration) await saveCache(path, record);
		if (reuse(record)) return cachedSnapshot(record, now, options.onFetchedAt);
		// Persist the cooldown before requesting, including for failures or process shutdown.
		await saveCache(path, { ...record, attemptedAt: now });
		try {
			const snapshot = await fetchUsage();
			const previous = record?.snapshot && record.fetchedAt !== undefined
				? { at: record.fetchedAt, snapshot: record.snapshot } : undefined;
			const updated = updateRecentRates(snapshot, previous, record?.comparisons ?? {}, now);
			const next = { attemptedAt: now, fetchedAt: now, ...updated };
			await saveCache(path, next);
			return cachedSnapshot(next, now, options.onFetchedAt);
		} catch {
			await saveCache(path, { attemptedAt: now });
			return undefined;
		}
	} catch {
		// Do not bypass coordination on disk errors and create a per-session request storm.
		return undefined;
	} finally {
		if (ownsLock) await rm(lock, { recursive: true, force: true }).catch(() => {});
	}
}
