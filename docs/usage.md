# Calculation and cache details

## Budget balance

The start of each window is inferred from its reported reset time and duration.

```text
planned usage = elapsed time / window duration × 100
budget balance = planned usage − actual usage
```

`B` rounds to one decimal place. Differences smaller than 0.05 percentage points show `B0%`, without a plus or minus sign. This is calculated budget precision, not extra precision in the provider's usage reading. Warning and pacing thresholds still use whole-point rounding.

For negative displayed balances, yellow means the remaining allowance requires at least a 20% reduction from the evenly planned consumption rate to last until reset. This is equivalent to having no more than 80% of the allowance that an even plan would leave at this point. Smaller deficits stay dim. The threshold is a planning heuristic, not a provider rule.

## Time hints

| Hint | Calculation |
| --- | --- |
| `C≈…` | Spare budget divided by the amount recent consumption exceeds the planned rate. If consumption is sustainable, use time until reset. Cap at reset and allowance exhaustion. |
| `C≤…` | Time until reset when no usable rate exists, conditional on staying within budget—not an observed-rate forecast. |
| `S` | Balance rounded to whole points is zero, but the measured consumption rate exceeds the planned rate. |
| `P≈…` | Budget deficit divided by the planned rate, assuming no further account usage. Exhausted allowance also gets a pause hint. |

Budget balances, warning colors, rates, and hints are calculated at the time of the latest successful usage fetch and stay unchanged until another successful fetch, even if the reported percentage is unchanged. Sessions reusing shared data use that same measurement time. Only reset countdowns advance between measurements; expired windows are hidden.

Hints use the unrounded balance. Multi-day times show days and hours, truncating minutes. Shorter times show hours/minutes or minutes; pause times round up to a minute, continue times round down. Durations below a minute show `<1m`.

Each limit keeps just one comparison point (percentage and timestamp), the last observed increase time, and its latest rate alongside the current snapshot—not a measurement list. A new rate needs at least 5 minutes between the comparison point and a positive consumption reading. After calculating a rate, that reading becomes the next comparison point. Frequent readings accumulate until a suitable interval exists; unchanged readings retain the latest usable estimate without refreshing its observation time. Comparison points older than 30 minutes are replaced with the previous measurement, and gaps longer than 30 minutes restart the comparison.

Rates expire after 30 minutes without an observed increase for the weekly window, or 10 minutes for the five-hour window. The longer weekly freshness limit accommodates whole-percentage readings that can stay unchanged during active use. Resets, usage decreases, or missing windows restart the comparison and clear the rate. Roughly on/below-budget limits without a usable rate use `C≤…`; over-budget limits use `P≈…` without needing a rate.

Rates include all account consumption over wall-clock time, including idle gaps. They do not measure individual agents or active working time. Provider rounding and bursty workloads limit their accuracy. No extra requests are made to calculate rates.

## Refresh and storage

- Every minute: update reset countdowns, hide expired windows, and read shared state. Recalculate pacing only for a new measurement. Redraw only changed values.
- Background checks, startup, reload, and model changes: fetch only if the last account-wide attempt was at least 5 minutes ago.
- After `agent_settled`: use a 1-minute request cooldown. Queue a refresh if necessary; another session's request after that work finished satisfies it too.
- Failed requests hide usage and obey the relevant cooldown. Expired limits stay hidden until fresh data arrives.
- `PI_OFFLINE=1` disables usage requests and cache refreshes.

Cache files live in `$XDG_CACHE_HOME/pi-codex-usage`, or `~/.cache/pi-codex-usage`. They contain the latest usage snapshot and at most one compact comparison record per limit. Storage does not grow with the number of requests. Legacy measurement lists are discarded on the next cache access under the account lock, without bypassing request cooldowns. Filenames hash the account ID; OAuth tokens are not stored.

A disk lock coordinates requests per account. Sessions sharing the directory see new data within a minute; sessions on different machines do not share these limits. Idle polling makes roughly 12 requests/hour per account. Frequent completed runs can raise that to at most one request/minute.
