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

Only available, unexpired limits appear, and only for `openai-codex` models. There are no commands or notifications. The extension uses Pi's credentials and an undocumented ChatGPT endpoint that may change.

See [calculation and cache details](docs/usage.md) for the exact rules.

## Development

```sh
npm test
pi --no-extensions -e ./ --model openai-codex/gpt-6-sol
```

For a persistent local install, use `pi install /absolute/path/to/pi-codex-usage` instead of the GitHub source. Remove any standalone `~/.pi/agent/extensions/codex-usage.ts` to avoid duplicate loading.
