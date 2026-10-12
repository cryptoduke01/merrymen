# Market feed recovery and account-specific decision research

CoinGecko Pro remains the preferred indexed source when its key is configured.
A transient outage or HTTP 429 can use GeckoTerminal's separately available
public API. Credentials are never sent to the public origin. Authentication
refusals, malformed data and a failed coordination store do not trigger fallback.

Each provider has its own shared cache, pacing and cooldown. Public requests are
spaced at least 6.5 seconds apart; Pro defaults to the existing 3-second spacing
and can be tuned to the plan (see [CoinGecko Pro pacing](#coingecko-pro-pacing)).
Repeated 429s back off up to 15 minutes, or longer when Retry-After requires it.
Non-fleet processes use a bounded process-local equivalent. Cache hits preserve
the original observation time, and the existing 120-second trading-tape freshness
limit and distinct-buyer, volume, route and liquidity checks remain in force.
Provider and primary-failure metadata make a working fallback distinguishable
from a recovered Pro subscription in the worker logs.

The public API documents [keyless access](https://apiguide.geckoterminal.com/authentication)
and approximately 10 requests/minute in its [API reference](https://api.geckoterminal.com/docs/index.html).
[CoinGecko's rate-limit guidance](https://docs.coingecko.com/docs/errors-and-rate-limits)
notes that failed requests consume rate capacity too. A fallback restores access
to eligible public data; it does not replenish paid credits or provide Pro throughput.

## CoinGecko Pro pacing

Two optional variables set how fast the Pro lane spends. Set them on the
orchestrator (every tenant child inherits them) and on web; both services read
the same names. Neither set means exactly the previous behaviour.

| Variable | Meaning |
| --- | --- |
| `MERRYMEN_COINGECKO_PRO_SPACING_MS` | Milliseconds between Pro requests on one lane. Default `3000` (20/min). Never below `60` (the plan's 1,000/min). |
| `MERRYMEN_COINGECKO_MONTHLY_CREDITS` | The plan's monthly credits. When set, the spacing is raised to a floor at which the lane, running flat out for a 30-day month, spends at most its share. |

The shares are 70% for the fleet worker lane (every tenant child, coordinated
through one SQLite file) and 20% for a process-local lane (the web service, or
a self-hosted worker). The last 10% is headroom, because failed requests are
counted too and the two services are configured separately. The floor is
`ceil(2,592,000,000 / (credits x share))` ms. It bounds the worst case; a lane
that idles spends less.

Recommended values for the current plan (about 5,000,000 credits a month,
1,000 requests a minute):

| Service | `..._PRO_SPACING_MS` | `..._MONTHLY_CREDITS` | Floor | Flat-out requests per 30 days |
| --- | --- | --- | --- | --- |
| Orchestrator (fleet lane) | `800` | `5000000` | 741 ms | 3,240,000 (64.8%) |
| Web | `2600` | `5000000` | 2,592 ms | 996,923 (19.9%) |

Both together stay under 85% of the month even if neither ever idles. A value
below the floor is raised to it and said once at startup. An unreadable value
keeps the default and is named once; the value itself is never printed. Each
process logs one `[gecko] coingecko-pro ... lane:` line with the pace it settled on.

**Evidence goes first.** Pool-evidence candle and trade legs (the Brain's,
and the token page's activity panel on web) use a second pacing row on the
Pro lane, so they no longer queue behind the sixty-second tape burst. That
row is priority, not extra quota: each slot it takes pushes the default row
(feeds, desk, facts, X, web charts) back by one. In any stretch of time the
two rows together make at most one request more than a single row could, so
the monthly floor above still holds. One 429 cooldown still covers both rows.
Each leg waits for a slot only within its own 5-second budget; a leg that
cannot get one in time reports `request-budget` and spends nothing. The
public lane has no second row: without a key, and during a Pro outage
fallback, every public request stays at least 6.5 seconds from the last.

**Plan refusals are latched.** On the Pro lane, a 401 or 403, or a body with
CoinGecko error code 10005 ("you may not have access to this endpoint"),
stops requests to that endpoint family (the path with ids and the query
removed) for one hour, fleet-wide. A latched read reports `plan-restricted`
and does not fall back to the public API. Each latch is logged once, by
endpoint family only. 429s and 5xx responses are never latched. A revoked
or mistyped key latches each family it touches in the same way, so the log
names every refused endpoint within a few minutes. Latches belong to the key
that was refused (stored as a short sha256 fingerprint, never the key), so
fixing or rotating `MERRYMEN_COINGECKO_PRO_API_KEY` and restarting asks
every endpoint again at once. A plan upgrade under the same key takes effect
when the hour runs out.

Web's chart reads on the Pro key now go through web's shared lane on its
default row: they are paced and respect the 429 cooldown that any other web
read set. Without a key, charts keep the previous unpaced public behaviour.

## Opt-in decision evidence

`MERRYMEN_DECISION_RESEARCH_ACCOUNTS` on the orchestrator accepts comma- or
space-separated complete smart-account addresses. It defaults to nobody and
accepts neither prefixes nor `all`. The child compares its active signed grant's
account, and applies this evidence only to the live fast-Trencher review.
Tenant preferences cannot opt another account in or change any signed authority.

For an unheld candidate, the background review reads an entry quote on its
factory-verified v3 route and an exit quote for the entry's output. At most four
bridge fee paths and one reverse path are read, within a five-second budget.
Research size is bounded by the existing strategy size, signed trade cap, cash,
daily headroom and any smaller early-entry ceiling. The decision receives quoted
venue friction, estimated gas for both operations and turnover fees, with missing
costs explicitly unknown. Quotes are independent current-state observations,
not a sequential simulation or guarantee. Protective exits do not await them.

The orchestrator also reconstructs this account's completed position cycles
from up to 2,000 durable canonical fills. It scores cycles closed within 30 days
only when current-period receipt evidence, weighted-average basis, entry/exit gas
and trade fees are complete. Partial sales stay in one cycle. Cross-period,
unmatched, incomplete or excessive histories do not become invented outcomes.
The summary names sample size, cost drag and gross wins consumed by costs.
It excludes failed-operation gas and account-level performance costs, and is not
total-account return, a predicted win rate, or an evaluation of skipped trades.
Recorded trade fees are preserved when submitted operations settle and when the
local ledger is mirrored. Historical missing assessments stay unknown; this does
not create fee accruals, collect fees or rewrite already-settled assessments.

Derived counts travel in a separate private `.own-learning.json` file, validated
against the current account, chain, epoch, grant expiry and five-minute age limit.
Public peer transport is unchanged. The summary reaches only the same account's
decision context; no private trade text, counterparty data or credentials are
passed through it. Legacy published outcomes are labelled gross before fees/gas.

The same entry reviews also get a momentum entry plan appended to the strategy
brief: the fast Trencher's mechanical exits as configured (stop, take profit,
time stop and liquidity drain), a minutes-long horizon, the round-trip cost as a
share of the entry, and what each exit still pays beyond the average fill price
the brackets are measured from (the exit leg, both turnover fees and gas; from
the quotes above when they are sane, or a gas and turnover-fee floor). It shows
how to estimate edge from the odds of reaching the take-profit before the stop
rather than inventing one, and says so when no odds could cover the cost.
It defines continuation and distribution over short windows and states that
missing news, fundamentals or social-media data is not on its own a reason to
hold for this strategy. Every disqualifier and check in the persona still applies.

With Fomo on and the owner's Fomo monitoring (or follow) enabled, the same opt-in
also queues shared Fomo research for the entry candidates that account's review
rotates through, so their next review carries the trader-flow lens. See
docs/fomo.md "Research for review candidates".

This opt-in changes research inputs only. It never changes per-trade/day caps,
operation counts, drawdown checks, signed expiry, execution routes or exit rules.

## Rollout checks

After reviewing and deploying the change, enable the allowlist only for the
intended smart account. Verify fresh public-provider cache observations and
screened tape, then verify that account's review includes cost evidence and its
matching outcome summary. A missing quote or empty history is a valid unknown.
Compare the persisted signed limits before and after rollout. Other accounts
must remain outside the research allowlist; their shared market feed benefits
from the provider fix without enabling this extra decision work.
