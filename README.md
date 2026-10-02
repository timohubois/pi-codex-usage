# pi-codex-usage

A small [Pi](https://pi.dev/) extension that shows Codex subscription usage in a right-aligned line above the editor.

```text
W31% R4d23h ≈0.57%/h
W99% R22h40m ≈0.04%/h 5H82% R2h15m ≈8%/h
```

- `W` / `5H`: weekly / 5-hour allowance used. Only valid, unexpired limits appear.
- `R`: time until that allowance resets.
- `≈…%/h`: remaining allowance (`100% − W` / `100% − 5H`) spread evenly over the hours until reset. Both limits use hourly pacing. Rates are rounded down to two decimals (more for tiny positive values), omit trailing zeros, and are capped at 100%/h for display. These are planning rates—not provider limits or guarantees about future use. With both limits present, stay within both budgets.

The line appears for `openai-codex` models, even at low usage. It disappears when no valid limits are available or for other providers; no blank row, placeholders, commands, or notifications. Usage turns yellow above 70% and red above 90%; the other figures stay dim.

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
