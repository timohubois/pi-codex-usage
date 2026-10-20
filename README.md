# pi-codex-usage

Codex allowance and pacing hints above the [Pi](https://pi.dev/) editor.

```text
W40% R3d12h B+10.0% (C≈1d0h)
```

## Install

```sh
pi install git:github.com/timohubois/pi-codex-usage
```

To update:

```sh
pi update git:github.com/timohubois/pi-codex-usage
```

Run `/reload` in each open Pi session after installing or updating.

## Login compatibility

- **Legacy `openai-codex` subscription login:** live allowance and pacing metrics, using the ChatGPT usage endpoint.
- **New `openai` “Sign in with ChatGPT” login:** live metrics through a separate **Codex CLI login**. Install `codex`, run `codex login` with the account you want to monitor, then reload Pi. The bar looks the same as before.
- **`openai` API key:** no widget; subscription allowance does not apply.

The new Pi token cannot access the old usage endpoint. The extension instead uses Codex's read-only `account/rateLimits/read` RPC, as Omarchy does. Codex handles credential refresh; no conversation or model request is created. The account ID must be available in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`); keychain-only credentials without that file are not supported. Unavailable usage stays hidden.

**Use the intended account in both Pi and Codex.** These are the Codex account's limits, not Pi's app-specific cap; the extension cannot verify that the accounts match. Check [ChatGPT usage](https://chatgpt.com/settings/usage) for per-app limits.

## Read the bar

The budget assumes spreading your allowance evenly between resets.

**Legend:** `W` weekly · `5H` five-hour · `R` reset · `B` budget balance · `C` continue · `S` slow · `P` pause.

| Value | Meaning |
| --- | --- |
| `W40%` | 40% of the weekly allowance used |
| `5H80%` | 80% of the 5-hour allowance used |
| `R3d12h` | Resets in 3 days, 12 hours |
| `B+10.0%` | 10 percentage points below an even usage budget |
| `B0%` | Roughly on pace—not a signal to stop |
| `B-30.0%` | 30 percentage points over budget |
| `(C≈1d0h)` | Estimated time to continue at the recent account-wide consumption rate before going over budget |
| `(C≤6d23h)` | No usable rate yet: potentially until reset, if usage stays within budget |
| `(S)` | Recent consumption is too fast to stay on pace |
| `(P≈1h30m)` | Pausing account-wide usage for about this long would restore pace |

Halfway through a window, 50% usage is on pace. Using 40% gives `B+10.0%`; using 80% gives `B-30.0%`. Balances show one decimal place; values rounding to zero show `B0%`.

Usage turns yellow above 70% and red above 90%. A negative `B` turns yellow when lasting until reset needs at least a 20% slowdown from the planned rate—not for every small deficit.

`•` separates the two limits. Stay within both budgets. Time hints are planning aids, not guarantees: changing agent activity changes consumption.

## Updates

- Reset countdowns and the shared cache are checked every minute, including while idle. Budget balance, rates, and hints update only with a new usage measurement.
- Background requests have a 5-minute cooldown; completed runs use a 1-minute cooldown.
- Sessions on the same machine share the account cache and request limits. The cache keeps only the latest snapshot and one comparison record per limit, not a measurement history.

Live metrics show only available, unexpired limits. Legacy `openai-codex` models use Pi's credentials and the undocumented ChatGPT usage endpoint; new `openai` subscription models use the Codex CLI as described above. There are no commands or notifications. Upstream usage APIs may change.

See [calculation and cache details](docs/usage.md) for the exact rules.

## Development

```sh
npm test
pi --no-extensions -e ./ --model openai-codex/gpt-6-sol
```

For a persistent local install, use `pi install /absolute/path/to/pi-codex-usage` instead of the GitHub source. Remove any standalone `~/.pi/agent/extensions/codex-usage.ts` to avoid duplicate loading.
