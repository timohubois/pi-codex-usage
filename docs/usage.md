# Calculation and cache details

## Budget balance

The start of each window is inferred from its reported reset time and duration.

```text
planned usage = elapsed time / window duration × 100
budget balance = planned usage − actual usage
```

`B` rounds to whole percentage points. Differences smaller than half a point show `B0%`, without a plus or minus sign.

For negative displayed balances, yellow means the remaining allowance requires at least a 20% reduction from the evenly planned consumption rate to last until reset. This is equivalent to having no more than 80% of the allowance that an even plan would leave at this point. Smaller deficits stay dim. The threshold is a planning heuristic, not a provider rule.

## Time hints

| Hint | Calculation |
| --- | --- |
| `C≈…` | Spare budget divided by the amount recent consumption exceeds the planned rate. If consumption is sustainable, use time until reset. Cap at reset and allowance exhaustion. |
| `C≤…` | Time until reset when no usable rate exists, conditional on staying within budget—not an observed-rate forecast. |
| `S` | Rounded balance is zero, but the measured consumption rate exceeds the planned rate. |
| `P≈…` | Budget deficit divided by the planned rate, assuming no further account usage. Exhausted allowance also gets a pause hint. |

Hints use the unrounded balance. Multi-day times show days and hours, truncating minutes. Shorter times show hours/minutes or minutes; pause times round up to a minute, continue times round down. Durations below a minute show `<1m`.

Recent rates use at least 5 minutes of positive usage observations from the last 30 minutes. They are discarded after 10 minutes without an observed increase, or when a window changes, usage decreases, or history is insufficient. Roughly on/below-budget limits then use `C≤…`; over-budget limits use `P≈…` without needing history.

Rates include all account consumption over wall-clock time, including idle gaps. They do not measure individual agents or active working time. Provider rounding and bursty workloads limit their accuracy. No extra requests are made to collect history.

## Refresh and storage

- Every minute: recalculate the display and read shared state. Redraw only changed values.
- Background checks, startup, reload, and model changes: fetch only if the last account-wide attempt was at least 5 minutes ago.
- After `agent_settled`: use a 1-minute request cooldown. Queue a refresh if necessary; another session's request after that work finished satisfies it too.
- Failed requests hide usage and obey the relevant cooldown. Expired limits stay hidden until fresh data arrives.
- `PI_OFFLINE=1` disables usage requests and cache refreshes.

Cache files live in `$XDG_CACHE_HOME/pi-codex-usage`, or `~/.cache/pi-codex-usage`. They contain usage snapshots and up to 30 minutes of history. Filenames hash the account ID; OAuth tokens are not stored.

A disk lock coordinates requests per account. Sessions sharing the directory see new data within a minute; sessions on different machines do not share these limits. Idle polling makes roughly 12 requests/hour per account. Frequent completed runs can raise that to at most one request/minute.
