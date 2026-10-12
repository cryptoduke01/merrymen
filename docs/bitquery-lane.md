# The Bitquery lane: flow facts from one budgeted process

The orchestrator holds the fleet's paid Bitquery key and answers flow
questions about Robinhood Chain coins from it. Nothing else holds the key: no
tenant child, no Brain service and no web process. A child that wants flow
facts asks the orchestrator over IPC.

A reading covers one coin:

- DEX buys and sells over the trailing 5, 15 and 60 minutes: USD in each
  direction, trade counts, and distinct buying and selling addresses.
- The venue (protocol) split over the hour.
- The largest single sells in the hour, as sizes and times only. No wallet or
  hash is included.
- Whether the coin's recorded creator sold on a DEX, or moved tokens out at
  all, in the last hour. This is `not-derivable` when the coin records no
  creator.

A reading is an indexer's record. It is not a price, a forecast or a reason to
trade. It never reaches equity, P&L, sizing, a cap, a guard or a grant.
Distinct addresses are not proven distinct people. A `null` means unknown and
is never read as zero.

The lane also has a third query, Uniswap v3 pools created for a token. It is
meant as a later source for the early book and nothing calls it yet.

## Rollout

1. **Check the query shapes before setting the key.** The three queries are in
   `worker/src/venues/bitquery-lane.ts`: `TOKEN_FLOW_QUERY`,
   `CREATOR_FLOW_QUERY` and `V3_POOLS_QUERY`. They were written from Bitquery's
   Robinhood Chain and Trading API documentation and have only been tested
   against recorded-shape fixtures. Run each one in the Bitquery IDE with the
   plan's key, using a busy Robinhood token and a 60-minute window, and
   confirm three things:
   - the `Trading` cube accepts `count(distinct: …, if: …)` and a
     `Block.Time` condition inside `if:`;
   - `Side: "Buy"` really is a trader buying the coin (compare one trade with
     the explorer);
   - the two-root creator query (`Trading` plus `EVM`) is accepted.

   If a shape is wrong, the lane logs the provider's reason once (scrubbed of
   addresses and keys) and answers `invalid-body` or `invalid-shape`. It never
   reports a wrong shape as no trades.
2. **Set `MERRYMEN_BITQUERY_API_KEY` on the orchestrator only.** Do not set it
   on `web`, on the Brain service, or under the names `BITQUERY_API_KEY` or
   `MERRYMEN_TOKEN`. `CHILD_SECRET_STRIP` removes all three names from every
   child. A copy on any other service is an extra credential for no purpose.
3. **Read the boot line.** The orchestrator logs one of the following:
   - `bitquery lane: on — 25000 points/UTC day (20000 for child evidence), 60 requests/min, 3 at once`
   - `bitquery lane: off — …`, with the reason.
4. **Turn on child evidence by account.** Children may ask only if their smart
   account is listed in `MERRYMEN_DECISION_RESEARCH_ACCOUNTS`, the same
   allowlist that decision research already uses (see
   [`decision-research.md`](decision-research.md)). Alan's account,
   `0x7Ac219f42F2303630646e09aa6507B0349bc5523`, is already on it. The allowlist
   is checked on every request, so a change applies without a respawn.
5. **Reconcile after a day.** Compare Bitquery's usage page with the lane's
   own counter: table `spend` in `<fleet home>/bitquery-lane/lane.sqlite`, with
   columns `points`, `calls` and `refused` per UTC day. If the real cost per
   call is higher than estimated, lower `MERRYMEN_BITQUERY_POINTS_PER_DAY`. Do
   not raise the per-query estimates in place of that.

To stop spending without removing the key, set `MERRYMEN_BITQUERY_LANE=0` and
redeploy. Every flow question then answers `unavailable`.

## Knobs (orchestrator)

| Var | Default | Meaning |
|---|---|---|
| `MERRYMEN_BITQUERY_API_KEY` | unset (lane off) | The plan's key. An `ory_at_…` V2 token is sent as `Authorization: Bearer`; anything else is sent as `X-API-KEY`. **Orchestrator only.** |
| `MERRYMEN_BITQUERY_LANE` | on when a key is set | `0` turns the lane off while keeping the key. |
| `MERRYMEN_BITQUERY_POINTS_PER_DAY` | `25000` (ceiling `100000`) | Points reserved per UTC day across every caller. 25,000 × 30 = 750,000, which leaves a quarter of a 1,000,000-point month as headroom for estimation error. Child evidence may use at most 80% of it, so X answers are never starved. |
| `MERRYMEN_BITQUERY_RPM` | `60` (ceiling `90`) | Requests started per rolling minute. The plan allows 90. |

A knob that is not a positive whole number is logged by its length, never
echoed, and its default applies. A value above the ceiling is clamped, and the
boot line says so. Concurrency is fixed at 3 of the plan's 6, which leaves room
for the gateway and the IDE.

## How spending is bounded

| Query | Points reserved | Cached for |
|---|---|---|
| token flow (3 cubes) | 15 | 60 s |
| creator flow (2 cubes) | 10 | 120 s |
| v3 pools (1 cube) | 5 | 300 s |

- **Points are reserved before each call.** The reservation is atomic, in
  SQLite under the fleet home, against the UTC day. A crash between the
  reservation and the request can overstate spend but never understate it.
  When the counter cannot be read or written, the call is refused.
- **Failed requests keep their reservation**, because the provider may bill
  them. Bitquery documents realtime queries at a flat 5 points per cube. The
  Trading cube's price is not documented, so it is assumed to be the same.
- **One cache serves the fleet**, keyed by query and token. A cache hit keeps
  the time the answer was observed. Concurrent identical questions share one
  request.
- **Provider refusals back off the whole lane:**
  - `429` backs off on a ladder from 1 to 15 minutes, or for `Retry-After` if
    that is longer. `402` holds off for an hour. Both are persisted, so a
    restart does not hammer the provider.
  - `401` or `403` holds off for 15 minutes in memory only, so a corrected key
    arriving by redeploy is used at once.
  - Any other failure of one query is not retried for 15 s.
- **Each child is rate-limited separately.** A child gets 6 new questions a
  minute and 2 at once. A repeat of a question already in flight is free.
- **Every path ends in an answer or a failure word**: `unavailable`, `budget`,
  `provider-cooldown`, `timeout`, `network`, `invalid-body`, `invalid-shape`,
  `invalid-request` or `http-NNN`. The orchestrator's ceiling on one child
  answer is 22 s, and the child waits at most 25 s. Nothing throws, and no
  tick waits on the lane.

## Who can ask what

- **The orchestrator's own answers** call `flowFor(token)`, exported from
  `worker/src/orchestrator.ts`, and spend from the whole day. For X replies,
  `flowFactLines(result)` (`worker/src/flow-facts.ts`) returns short lines that
  are already attributed ("on-chain DEX data, last 15m: $1.4k bought vs $610
  sold (8 buyers, 4 sellers)"). A writer may paraphrase them. The lines never
  contain an address, a wallet list, a size or P&L. When there is nothing
  honest to say, the list is empty, never "no activity".
- **A child** uses `createFlowClient(processFlowPort())`
  (`worker/src/flow-broker.ts`) and may ask for one thing: the reading for a
  token address. It cannot choose a query, a window, a limit or a creator. It
  never names a tenant, and if it adds one, the field is ignored and logged.
  The broker shares Fomo's IPC channel. That channel exists only while
  `MERRYMEN_FOMO_ENABLED=1`, and without it the client answers `unavailable`
  immediately.
- **The creator is resolved on the orchestrator**, from the deployer the token
  records on chain (`readTokenDeployer`, Pons-template tokens only). The
  address is used as a query variable and appears in no fact, log line or
  reply. A coin that records no creator is `not-derivable`. A failed chain read
  is `unavailable`. Neither is ever reported as "did not sell".

## Where it plugs in (not wired yet)

The lane does not feed Brain or the fast-Trencher review yet, because another
branch is changing that code. When it does:

- **Brain lens.** `renderFlowLens(result)` returns a block of at most 1,200
  characters: an attribution line ("Indexer data, not a forecast"), one
  compact JSON object, and a closing "WHAT THIS IS NOT" line. It returns
  `null` on any failure, on an hour with no indexed trades, or if anything in
  the block looks like an address. It is meant for the lens key
  `onchain-flow` (`ONCHAIN_FLOW_LENS`).
  - Brain accepts a lens only after `services/brain` registers the key
    (`schemas.py` `LENS_KEYS`, plus an analyst prompt in `analyst.py`) and
    advertises it on `/health`.
  - The worker should then set `signals[ONCHAIN_FLOW_LENS]` beside
    `attachLens` in `worker/src/fomo-child.ts`, behind the same `lens_keys`
    handshake.
- **Review evidence.** As an alternative, or in addition, the fast-Trencher
  review in `worker/src/index.ts` can await
  `createFlowClient(processFlowPort()).facts(token)` with a 5-second
  `timeoutMs`, as `entryCostEvidence` bounds its quotes. It would add the
  rendered block to the evidence for accounts on the decision-research
  allowlist only. A missing reading is "unavailable", never "no flow".
- **Early book.** `BitqueryLane.v3Pools(token)` returns PoolCreated
  candidates from the pinned Uniswap v3 factory. Each one still has to be
  confirmed with the factory's `getPool` and pass the existing depth, TWAP and
  divergence guards before it can be priced. A candidate is never a route on
  its own.

## Also fixed with this lane

- **Gateway auth.** Merry Circle tokens were sent to the gateway in
  `X-API-KEY`, but the gateway reads only `Authorization: Bearer`. Every
  holder's discovery call failed with 401 and was reported as an expired token.
  Gateway calls now send the token as Bearer, and the hint names the actual
  cause: a 401 is the token, a 403 is the holdings, and a 503 is the gateway's
  own state.
- **No discovery fan-out.** `BITQUERY_API_KEY` and `MERRYMEN_TOKEN` are
  stripped from children. In hosted mode both are house keys that a child can
  only read from the environment, and discovery defaults on, so either one on
  the orchestrator would have made every child poll Bitquery. A hosted child
  also no longer reads the house's brain key as a gateway discovery token. A
  tenant's own gateway brain key still opens discovery on that tenant's own
  quota.
