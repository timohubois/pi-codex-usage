import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The endpoint is used by ChatGPT but is not a documented public API.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WIDGET_KEY = "codex-usage";
const POLL_MS = 10 * 60_000;
const TICK_MS = 5 * 60_000;
const AFTER_MESSAGE_MS = 1_500;
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

export function pace(window: UsageWindow, now: number, unit: "day" | "hour" = "day"): number | undefined {
	if (now >= window.resetAt) return undefined;
	const remaining = Math.max(0, 100 - window.usedPercent);
	// Percentage points of this window's allowance per rolling day or hour.
	return remaining * (unit === "hour" ? 3_600_000 : 86_400_000) / (window.resetAt - now);
}

function displayPace(rate: number): string {
	// Cap only the display; round down so we don't suggest more than the budget permits.
	return `${(Math.floor(Math.min(rate, 100) * 10 + 1e-9) / 10).toFixed(1)}%`;
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
	let afterMessage: ReturnType<typeof setTimeout> | undefined;
	let lastDisplay: string | undefined;
	let controller: AbortController | undefined;
	let inFlight: Promise<void> | undefined;
	let generation = 0;
	let lastAttempt = 0;

	function setWidget(ctx: ExtensionContext, parts: MetricPart[] | undefined): void {
		const display = parts?.map(({ text, color }) => `${color ?? "dim"}:${text}`).join(" ");
		if (display === lastDisplay) return;
		lastDisplay = display;
		if (!parts) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
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
		}), { placement: "aboveEditor" });
	}

	function metrics(now: number): MetricPart[] | undefined {
		if (!snapshot) return undefined;
		const parts: MetricPart[] = [];
		if (snapshot.weekly) {
			const weekly = snapshot.weekly;
			if (now >= weekly.resetAt) {
				parts.push({ text: "W?" }); // Don't display the expired window as current.
			} else {
				parts.push({
					text: `W${weekly.usedPercent}%`,
					color: weekly.usedPercent > 90 ? "error" : weekly.usedPercent > 70 ? "warning" : undefined,
				});
				parts.push({ text: `R${countdown(weekly.resetAt, now)}` });
			}
		}
		if (snapshot.weekly) {
			const rate = pace(snapshot.weekly, now);
			if (rate !== undefined) {
				parts.push({ text: `D${displayPace(rate)}` });
			}
		}
		if (snapshot.fiveHour) {
			const fiveHour = snapshot.fiveHour;
			if (now >= fiveHour.resetAt) {
				parts.push({ text: "5H?" });
			} else {
				parts.push({
					text: `5H${fiveHour.usedPercent}%`,
					color: fiveHour.usedPercent > 90 ? "error" : fiveHour.usedPercent > 70 ? "warning" : undefined,
				});
				parts.push({ text: `R${countdown(fiveHour.resetAt, now)}` });
				const rate = pace(fiveHour, now, "hour");
				if (rate !== undefined) {
					parts.push({ text: `H${displayPace(rate)}` });
				}
			}
		}
		return parts;
	}

	function show(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		// An empty widget reserves the row while usage is loading or unavailable.
		setWidget(ctx, ctx.model?.provider === "openai-codex" ? (metrics(Date.now()) ?? []) : undefined);
	}

	function cancel(): void {
		generation++;
		controller?.abort();
		controller = undefined;
		if (afterMessage) clearTimeout(afterMessage);
		afterMessage = undefined;
		inFlight = undefined;
		snapshot = undefined;
		lastAttempt = 0;
	}

	function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex" || process.env.PI_OFFLINE === "1") {
			return Promise.resolve();
		}
		if (inFlight) return inFlight;
		if (!force && Date.now() - lastAttempt < POLL_MS) return Promise.resolve();
		lastAttempt = Date.now();
		const currentGeneration = generation;
		const abort = new AbortController();
		controller = abort;
		const request = (async () => {
			try {
				// Use Pi's credential resolver so OAuth refresh is handled by Pi.
				const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (currentGeneration !== generation) return;
				const accountId = token && accountIdFromToken(token);
				if (!token || !accountId) throw new Error("Codex OAuth unavailable");
				const response = await fetch(USAGE_URL, {
					headers: {
						Authorization: `Bearer ${token}`,
						"ChatGPT-Account-Id": accountId,
						Accept: "application/json",
					},
					signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]),
				});
				if (!response.ok) throw new Error(`Codex usage HTTP ${response.status}`);
				const next = parseUsage(await response.json(), Date.now());
				if (!next) throw new Error("Codex usage windows unavailable");
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
			if (inFlight === request) inFlight = undefined;
		});
		return request;
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cancel();
		if (interval) clearInterval(interval);
		lastDisplay = undefined; // Pi may have cleared widgets when changing sessions.
		show(ctx);
		void refresh(ctx, true);
		interval = setInterval(() => {
			show(ctx); // Local countdown and pace; only update the widget when text changed.
			if (ctx.isIdle()) return; // No network polling while Pi is waiting for a prompt.
			const resetPassed = [snapshot?.weekly, snapshot?.fiveHour].some((w) => w && w.resetAt <= Date.now());
			if (resetPassed && Date.now() - lastAttempt >= TICK_MS) {
				void refresh(ctx, true); // Retry a stale reset no more than once every five minutes.
			} else {
				void refresh(ctx); // Otherwise fetch only when the ten-minute poll is due.
			}
		}, TICK_MS);
		interval.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cancel();
		show(ctx);
		void refresh(ctx, true);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
		const resetPassed = [snapshot?.weekly, snapshot?.fiveHour].some((w) => w && w.resetAt <= Date.now());
		if (resetPassed || Date.now() - lastAttempt >= POLL_MS) void refresh(ctx, true);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
		// Coalesce nearby responses and give the provider time to account for them.
		if (afterMessage) clearTimeout(afterMessage);
		afterMessage = setTimeout(() => {
			afterMessage = undefined;
			void refresh(ctx, true);
		}, AFTER_MESSAGE_MS);
		afterMessage.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancel();
		if (interval) clearInterval(interval);
		interval = undefined;
		if (ctx.mode === "tui") setWidget(ctx, undefined);
	});
}
