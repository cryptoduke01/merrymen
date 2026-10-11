# Market feed recovery and account-specific decision research

CoinGecko Pro remains the preferred indexed source when its key is configured.
A transient outage or HTTP 429 can use GeckoTerminal's separately available
public API. Credentials are never sent to the public origin. Authentication
refusals, malformed data and a failed coordination store do not trigger fallback.

Each provider has its own shared cache, pacing and cooldown. Public requests are
spaced at least 6.5 seconds apart; Pro retains the existing 3-second spacing.
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

Derived counts travel in a separate private `.own-learning.json` file, validated
against the current account, chain, epoch, grant expiry and five-minute age limit.
Public peer transport is unchanged. The summary reaches only the same account's
decision context; no private trade text, counterparty data or credentials are
passed through it. Legacy published outcomes are labelled gross before fees/gas.

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
