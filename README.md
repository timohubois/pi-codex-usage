# pi-codex-usage

A small [Pi](https://pi.dev/) extension that shows Codex subscription usage in a right-aligned line above the editor.

```text
W40% R3d12h B+10%
W40% R3d12h B+10% 5H80% R2h30m B-30%
```

- `W` / `5H`: weekly / 5-hour allowance used. Only valid, unexpired limits appear.
- `R`: time until that allowance resets.
- `B`: budget balance against an even usage pace, in percentage points: elapsed fraction of the window × 100 − allowance used. `B+10%` means 10 points below budget; `B0%` means on pace; `B-30%` means 30 points over budget—slow down. Values round to at most two decimals with no trailing zeros or signed zero. Both limits use their reported duration and reset time to infer elapsed time.

For example, halfway through a window, 50% usage is on pace. Using 40% gives `B+10%`; using 80% gives `B-30%`. A full reset with no usage gives `B0%`. This is a planning indicator, not remaining allowance, a provider limit, or a guarantee of future availability.

The line appears for `openai-codex` models, even at low usage. It disappears when no valid limits are available or for other providers; no blank row, placeholders, commands, or notifications. Usage turns yellow above 70% and red above 90%; negative displayed balances turn yellow. Positive and zero balances, and countdowns, stay dim.

## Install

Install from GitHub:

```sh
pi install git:github.com/timohubois/pi-codex-usage
```

To install from a local checkout instead, run `pi install /absolute/path/to/pi-codex-usage`. Remove any standalone `~/.pi/agent/extensions/codex-usage.ts` first to avoid loading two copies.

After new commits are pushed to GitHub, update with (no GitHub Release required):

```sh
pi update git:github.com/timohubois/pi-codex-usage
```

Run `/reload` in an open Pi session after installing or updating.

## Development

Run `npm test`. To try the package without installing it:

```sh
pi --no-extensions -e ./ --model openai-codex/gpt-6-sol
```

The extension uses Pi's existing Codex credentials with an **undocumented** usage endpoint that may change. It refreshes after activity but does not poll the network periodically while Pi is idle. Failed requests hide the line rather than displaying stale usage.
