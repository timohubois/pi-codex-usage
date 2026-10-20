import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Read identity only. Codex owns token storage, refresh, and any rotated credentials.
export async function codexAccountId(): Promise<string | undefined> {
	try {
		const auth = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8"));
		if (auth.auth_mode !== "chatgpt") return undefined;
		const id = auth.tokens?.account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

// Same read-only RPC used by Omarchy's agents widget. No conversation is created.
export function codexUsage(accountId: string, signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("Codex usage cancelled"));
		const child = spawn("codex", ["-s", "read-only", "-a", "on-request", "app-server"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		const lines = createInterface({ input: child.stdout });
		let settled = false;
		let bytes = 0;
		let stage = 1;
		const timer = setTimeout(() => finish(new Error("Codex usage timed out")), 12_000);
		const abort = () => finish(new Error("Codex usage cancelled"));
		function finish(error?: Error, value?: unknown): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			lines.close();
			child.stdin.end();
			child.kill();
			// Reap an unresponsive app-server as well, without keeping Pi alive.
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
			killTimer.unref();
			child.once("close", () => clearTimeout(killTimer));
			if (error) reject(error);
			else resolve(value);
		}
		function send(message: unknown): void {
			child.stdin.write(JSON.stringify(message) + "\n");
		}
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", () => finish(new Error("Codex CLI unavailable")));
		child.stdin.on("error", () => finish(new Error("Codex RPC input closed")));
		child.on("exit", () => finish(new Error("Codex RPC exited before replying")));
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1_048_576) finish(new Error("Codex RPC response too large"));
		});
		lines.on("line", (line) => {
			if (settled) return;
			try {
				const message = JSON.parse(line);
				if (message.id !== stage) return; // Ignore notifications.
				if (message.error) return finish(new Error("Codex usage RPC failed"));
				if (stage === 1) {
					stage = 2;
					send({ method: "initialized", params: {} });
					send({ id: 2, method: "account/rateLimits/read", params: {} });
					return;
				}
				const result = message.result;
				if (result?.accountId !== undefined && result.accountId !== accountId) {
					return finish(new Error("Codex account changed"));
				}
				const limits = result?.rateLimits;
				const window = (value: unknown) => {
					if (!value || typeof value !== "object") return undefined;
					const w = value as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
					return {
						used_percent: w.usedPercent,
						limit_window_seconds: typeof w.windowDurationMins === "number" ? w.windowDurationMins * 60 : undefined,
						reset_at: w.resetsAt,
					};
				};
				finish(undefined, { rate_limit: {
					primary_window: window(limits?.primary), secondary_window: window(limits?.secondary),
				} });
			} catch {
				finish(new Error("Invalid Codex usage RPC response"));
			}
		});
		send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi-codex-usage", version: "0.1.0" } } });
	});
}
