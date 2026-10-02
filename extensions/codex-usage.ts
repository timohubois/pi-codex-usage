import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sharedUsage } from "../lib/shared-usage.ts";

// The endpoint is used by ChatGPT but is not a documented public API.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WIDGET_KEY = "codex-usage";
const TICK_MS = 60_000;
export type UsageWindow = { usedPercent: number; resetAt: number; durationSeconds: number };
export type UsageSnapshot = { weekly?: UsageWindow; fiveHour?: UsageWindow };
type MetricPart = { text: string; color?: "warning" | "error" };

type RawWindow = {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
	reset_after_seconds?: unknown;
};

function parseWindow(value: unknown, now: number): UsageWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const w = value as RawWindow;
	const durationSeconds = w.limit_window_seconds;
	const usedPercent = w.used_percent;
	const resetAt =
		typeof w.reset_at === "number"
			? w.reset_at * 1000
			: typeof w.reset_after_seconds === "number"
				? now + w.reset_after_seconds * 1000
				: NaN;
	if (
		typeof durationSeconds !== "number" ||
		!Number.isFinite(durationSeconds) ||
		typeof usedPercent !== "number" ||
		!Number.isFinite(usedPercent) ||
		usedPercent < 0 ||
		usedPercent > 100 ||
		!Number.isFinite(resetAt) ||
		resetAt < now - 60_000 ||
		resetAt > now + (durationSeconds + 60) * 1000
	) return undefined;
	return { durationSeconds, usedPercent, resetAt };
}

export function parseUsage(data: unknown, now: number): UsageSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const rateLimit = (data as { rate_limit?: unknown }).rate_limit;
	if (!rateLimit || typeof rateLimit !== "object") return undefined;
	const windows = rateLimit as { primary_window?: unknown; secondary_window?: unknown };
	const snapshot: UsageSnapshot = {};
	for (const raw of [windows.primary_window, windows.secondary_window]) {
		const window = parseWindow(raw, now);
		if (!window) continue;
		// The API may make either the 5-hour or the weekly window primary.
		if (window.durationSeconds >= 6 * 86_400 && window.durationSeconds <= 8 * 86_400) {
			snapshot.weekly = window;
		} else if (window.durationSeconds >= 4 * 3_600 && window.durationSeconds <= 6 * 3_600) {
			snapshot.fiveHour = window;
		}
	}
	return snapshot.weekly || snapshot.fiveHour ? snapshot : undefined;
}

export function countdown(resetAt: number, now: number): string {
	const remaining = Math.max(0, resetAt - now);
	if (remaining >= 86_400_000) {
		const days = Math.floor(remaining / 86_400_000);
		const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
		return `${days}d${hours}h`;
	}
	if (remaining >= 3_600_000) {
		const hours = Math.floor(remaining / 3_600_000);
		const minutes = Math.floor((remaining % 3_600_000) / 60_000);
		return `${hours}h${minutes}m`;
	}
	return `${Math.ceil(remaining / 60_000)}m`;
}

export function budgetBalance(window: UsageWindow, now: number): number | undefined {
	if (now >= window.resetAt) return undefined;
	const duration = window.durationSeconds * 1000;
	const elapsed = Math.max(0, Math.min(duration, now - (window.resetAt - duration)));
	// Positive means below an even usage budget; negative means ahead of it.
	return elapsed / duration * 100 - window.usedPercent;
}

export function displayBalance(balance: number): string {
	const magnitude = Number(Math.abs(balance).toFixed(2));
	if (magnitude === 0) return "B0%"; // Avoid signed zero after rounding.
	return `B${balance < 0 ? "-" : "+"}${magnitude}%`;
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let snapshot: UsageSnapshot | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let deferredWork: ReturnType<typeof setTimeout> | undefined;
	let queuedWorkAt: number | undefined;
	let lastDisplay: string | undefined;
	let requestRender: (() => void) | undefined;
	let accountId: string | undefined;
	let controller: AbortController | undefined;
	let inFlight: Promise<void> | undefined;
	let generation = 0;

	function setWidget(ctx: ExtensionContext, parts: MetricPart[] | undefined): void {
		const display = parts?.map(({ text, color }) => `${color ?? "dim"}:${text}`).join(" ");
		if (display === lastDisplay) return;
		lastDisplay = display;
		if (!parts) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			requestRender?.();
			requestRender = undefined;
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number): string[] {
					// Metric labels and values are ASCII, so their lengths equal terminal columns.
					// Style after measuring to keep ANSI escapes out of the width calculation.
					let remaining = Math.max(0, width);
					let line = "";
					for (const { text, color } of parts) {
						const separator = line ? " " : "";
						if (remaining <= separator.length) break;
						const chunk = text.slice(0, remaining - separator.length);
						line += separator + theme.fg(color ?? "dim", chunk);
						remaining -= separator.length + chunk.length;
						if (chunk.length < text.length) break;
					}
					return [" ".repeat(remaining) + line];
				},
			};
		}, { placement: "aboveEditor" });
		requestRender?.();
	}

	function metrics(now: number): MetricPart[] | undefined {
		if (!snapshot) return undefined;
		const parts: MetricPart[] = [];
		for (const [label, window] of [["W", snapshot.weekly], ["5H", snapshot.fiveHour]] as const) {
			if (!window) continue;
			const balance = budgetBalance(window, now);
			if (balance === undefined) continue; // Hide expired windows until fresh data arrives.
			parts.push({
				text: `${label}${window.usedPercent}%`,
				color: window.usedPercent > 90 ? "error" : window.usedPercent > 70 ? "warning" : undefined,
			});
			parts.push({ text: `R${countdown(window.resetAt, now)}` });
			const text = displayBalance(balance);
			parts.push({ text, color: text.startsWith("B-") ? "warning" : undefined });
		}
		return parts.length ? parts : undefined;
	}

	function show(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		setWidget(ctx, ctx.model?.provider === "openai-codex" ? metrics(Date.now()) : undefined);
	}

	function cancel(): void {
		generation++;
		controller?.abort();
		controller = undefined;
		if (deferredWork) clearTimeout(deferredWork);
		deferredWork = undefined;
		queuedWorkAt = undefined;
		inFlight = undefined;
		snapshot = undefined;
		accountId = undefined;
	}

	function refresh(ctx: ExtensionContext, afterWorkAt?: number): Promise<void> {
		if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex" || process.env.PI_OFFLINE === "1") {
			return Promise.resolve();
		}
		if (inFlight) {
			if (afterWorkAt !== undefined) queuedWorkAt = Math.max(queuedWorkAt ?? afterWorkAt, afterWorkAt);
			return inFlight;
		}
		if (afterWorkAt !== undefined && deferredWork) {
			clearTimeout(deferredWork);
			deferredWork = undefined;
		}
		const currentGeneration = generation;
		const abort = new AbortController();
		controller = abort;
		const request = (async () => {
			try {
				let initialToken: string | undefined;
				if (!accountId) {
					initialToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
					if (currentGeneration !== generation) return;
					accountId = initialToken && accountIdFromToken(initialToken);
				}
				const id = accountId;
				if (!id) throw new Error("Codex OAuth unavailable");
				const next = await sharedUsage(id, async () => {
					if (abort.signal.aborted) throw new Error("Usage refresh cancelled");
					// Resolve credentials only for actual requests, not every local cache read.
					const token = initialToken ?? await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
					if (!token || accountIdFromToken(token) !== id) throw new Error("Codex account changed");
					const response = await fetch(USAGE_URL, {
						headers: {
							Authorization: `Bearer ${token}`,
							"ChatGPT-Account-Id": id,
							Accept: "application/json",
						},
						signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]),
					});
					if (!response.ok) throw new Error(`Codex usage HTTP ${response.status}`);
					const usage = parseUsage(await response.json(), Date.now());
					if (!usage) throw new Error("Codex usage windows unavailable");
					return usage;
				}, {
					afterWorkAt,
					onDeferred: (delayMs) => {
						if (currentGeneration !== generation || afterWorkAt === undefined) return;
						if (deferredWork) clearTimeout(deferredWork);
						deferredWork = setTimeout(() => {
							deferredWork = undefined;
							void refresh(ctx, afterWorkAt);
						}, delayMs);
						deferredWork.unref?.();
					},
				});
				if (currentGeneration !== generation) return;
				snapshot = next;
			} catch {
				if (currentGeneration !== generation) return;
				// Never display an old percentage as though it were current.
				snapshot = undefined;
			} finally {
				if (currentGeneration === generation) {
					controller = undefined;
					show(ctx);
				}
			}
		})();
		inFlight = request;
		void request.finally(() => {
			if (inFlight !== request) return;
			inFlight = undefined;
			if (queuedWorkAt !== undefined && currentGeneration === generation) {
				const workAt = queuedWorkAt;
				queuedWorkAt = undefined;
				void refresh(ctx, workAt);
			}
		});
		return request;
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cancel();
		if (interval) clearInterval(interval);
		lastDisplay = undefined; // Pi may have cleared widgets when changing sessions.
		show(ctx);
		void refresh(ctx);
		interval = setInterval(() => {
			show(ctx); // Local time advances even while idle; redraw only changed values.
			void refresh(ctx); // Read the shared cache; its account-wide cooldown limits requests.
		}, TICK_MS);
		interval.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cancel();
		show(ctx);
		void refresh(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		void refresh(ctx, Date.now()); // Prefer fresh post-work usage, with a shared one-minute cooldown.
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancel();
		if (interval) clearInterval(interval);
		interval = undefined;
		if (ctx.mode === "tui") setWidget(ctx, undefined);
	});
}
