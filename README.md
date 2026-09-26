# pi-codex-usage

A small [Pi](https://pi.dev/) extension that shows Codex subscription usage in a right-aligned line above the editor.

```text
W31% R4d23h D13.9%
W31% R4d23h D13.9% 5H82% R2h15m H8.0%
```

- `W` / `5H`: weekly / 5-hour allowance used. The 5-hour group appears only if reported.
- `R`: time until that allowance resets.
- `D` / `H`: allowance remaining (`100% − W` / `100% − 5H`) divided by time until that window resets, scaled to 24 hours / one hour. Rounded down and capped at 100% for display, these are planning rates—not provider limits or guarantees about future use.

The line stays present for `openai-codex` models, even at low usage. It remains blank while data is unavailable and disappears for other providers. Usage turns yellow above 70% and red above 90%; the other figures stay dim.

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

The extension uses Pi's existing Codex credentials with an **undocumented** usage endpoint that may change. It refreshes after activity but does not poll the network periodically while Pi is idle. Failed requests leave the reserved line blank rather than displaying stale usage.
