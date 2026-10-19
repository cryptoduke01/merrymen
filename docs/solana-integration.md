# Solana alongside Robinhood Chain

Implementation status: 2026-10-18. This branch contains runnable **paper and live
Solana trading code**, an authenticated dashboard, bounded custody, durable
settlement and an opt-in autonomous strategy. **Nothing has been deployed,
funded or traded on a public network by this work.** Live execution remains
unavailable until an explicitly configured, verified immutable vault program
and the other release prerequisites below exist.

The first live market is **USDG ↔ wrapped SOL (WSOL)**. Broader SPL-token paper
trading is supported through the local CLI; arbitrary SPL/Token-2022 live
trading, bridging and Solana parity across every product surface are unfinished.
There is no measured claim yet that Solana outperforms Robinhood Chain.

## Implemented paths

| Capability | Current implementation |
|---|---|
| Identity and isolation | Case-sensitive Solana identifiers and `sol:<owner>` agent IDs; a separate wallet binding, mode, policy and book per existing tenant. EVM grants and the RH executor retain their existing boundaries. |
| Authenticated app | `/solana`, Privy embedded Solana wallet creation, wallet-ownership proof, per-chain consent and limits, trade previews, paper/live requests, pending receipts, owner controls and worker status. |
| Paper | Real mint reads and Jupiter quotes, conservative simulated fills, exact integer accounting, drawdown checks and durable idempotency. Available through authenticated app/API and a separate local-only CLI. |
| Live custody | Actual Anchor program, owner-PDA vault, bounded sessions, sequence/epoch checks, isolated Jupiter CPI, token/native recovery and owner revocation. Compiled and exercised locally as SBF; undeployed. |
| Live execution | Versioned transactions with distinct session and fee-payer signatures, strict instruction/ALT validation, simulation, durable admission before send, finalized receipt verification and restart reconciliation. |
| Accounting | SQLite locally or shared PostgreSQL; atomic policy checks, one pending live request per vault, encrypted session keys, exact cost basis, owner capital flows and explicit unknown-fee records. |
| Autonomous trading | Dedicated Solana worker runs an explicitly enabled USDG/WSOL target-allocation strategy in the account's selected paper or live mode. |

The main application boundary is
[`solana-app-runtime.ts`](../worker/src/solana-app-runtime.ts). Its dependencies
are the [market adapter](../worker/src/solana-market.ts),
[live executor](../worker/src/solana-executor.ts),
[settlement verifier](../worker/src/solana-settlement.ts),
[shared trading store](../worker/src/solana-trading-store.ts) and
[autonomous worker](../worker/src/solana-agent.ts). The
[custody source and local verification guide](../contracts/solana/README.md)
and [shared program ABI](../packages/core/src/solana-live.ts) describe the
on-chain boundary.

## Wallet authority and consent

The existing tenant session and a verified current Privy identity are both
required by the Solana API. A one-time, expiring Ed25519 challenge binds the
Solana owner to that tenant and identity. The binding message grants no trading
or withdrawal authority. The server derives the owner from this binding; trade
requests cannot choose another tenant, owner or vault. Account changes invalidate
stale browser actions, and ambiguous embedded-wallet selection fails closed.

New bindings start in paper mode with no active strategy. Live mode requires its
own explicit consent and reviewed limits. Robinhood consent never enables
Solana. Changing mode disables the Solana strategy until it is enabled again;
settings revisions are checked under the same database lock as trade admission.

For live setup, the browser generates a new bounded session seed. The owner
wallet signs the prepared vault initialization, token-account setup and session
registration transaction. The server verifies the exact prepared message and
owner signature, persists signed bytes before submission, and activates the
session only after finalized registration and matching on-chain limits. The
owner private key never enters the server. The session seed is encrypted at
rest with AES-256-GCM using `MERRYMEN_STORE_DEK`; its encrypted contents are bound
to tenant, owner, program, vault, session and epoch. The same encryption
requirement applies to local live sessions.

The distinct house fee payer pays execution fees and temporary-account rent.
It must differ from both owner and session, and receives no custody authority.
Owner-signed setup and recovery transactions use the owner as payer.

## Custody, limits and buy breakers

The vault PDA uses `["vault", owner]`. The owner alone initializes it, replaces
sessions, revokes authority, clears the on-chain breaker and withdraws assets.
Session replacement increments its epoch without resetting the sequence,
rolling spend history or breaker. The program enforces a positive per-trade
USDG limit, rolling 24-hour USDG limit, owner-signed per-trade and rolling 24-hour
WSOL input limits, at most 96 operations per rolling day, expiry, expected
sequence and expected session epoch. Both buys and exits are subject to those
bounds; exit attempts cannot bypass caps or expiry. Sells are charged their full
WSOL input as well as their USDG proceeds, so a session or quote cannot sell the
position for dust: the worst a compromised session can do in a day is spend the
signed daily USDG on buys and the signed daily WSOL on sells.

For each swap, the program transfers exactly the authorized input to the token
account of `["swap", vault, sequence]`. Only that per-sequence authority signs the
Jupiter CPI. The route cannot receive the vault state, owner, session, fee payer,
source custody account, owner refund account or other custody-owned token
accounts. The destination custody account may receive output without receiving
a vault signature. Actual output balance delta must meet the minimum; residual
input returns to the vault and the temporary input account closes. Preexisting
token donations to that predictable temporary account go to the owner's
canonical input account, keeping trade receipts consistent with vault deltas.
Settlement separately verifies the proven lamport refund from its closure.

Jupiter's program is pinned. The accepted instruction is ExactIn
`shared_accounts_route`, with bound input/output/slippage, zero platform fee and
at most 100 bps slippage. Its discriminator is independently tested against
SHA-256 of the Anchor instruction name. The worker also validates route quantity
conservation, intermediate balances, allocation and cycles. Unknown instruction
forms, unrelated setup/cleanup instructions or account substitutions fail closed.

Two buy breakers have different roles:

- The **worker drawdown breaker** uses fresh executable exit quotes, cash and the
  portfolio high-water mark. A breach persists a buy pause even if prices later
  recover. An owner-signed, finalized resume action clears that worker pause;
  it preserves the limits and high-water mark, so a continuing breach pauses
  buying again. No on-chain portfolio-price oracle is claimed.
- The **on-chain breaker** can be set by the owner or active session and cleared
  only by the owner. Revocation also sets it. It blocks buys while leaving exits
  subject to the other on-chain checks. A worker drawdown observation is not
  itself an on-chain breaker transaction; the worker enforces its durable pause
  at admission, and the contract independently enforces its own breaker flag.

Live assets are deliberately pinned to:

| Asset | Mint | Program / decimals |
|---|---|---|
| USDG | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | Token-2022 / 6 |
| WSOL | `So11111111111111111111111111111111111111112` | SPL Token / 9 |

USDG's known issuer authorities are an explicit cash-token trust assumption.
Active or scheduled nonzero transfer fees, configured transfer hooks and unknown
extensions fail closed. Other token issuers do not inherit that exception. The
broader paper mint screen refuses new buys with unsafe mint authorities or
extensions; exits still require valid data, a route, balances and policy limits.

## Settlement, accounting and owner recovery

Amounts, limits and cost basis use integer base units; USDG has six decimals.
Quotes, mint observations and risk evidence expire within 30 seconds. Evidence
freshness and current limits are rechecked after obtaining the database lock,
so a slow concurrent writer cannot turn old approval into a new trade.

A live request stores its exact signed transaction, signature, sequence,
evidence and reserved budgets before any send. Request IDs are scoped to the
bound account and reject changed intent payloads. Database uniqueness prevents
two pending submissions for the same vault. An interrupted or ambiguous send
reconciles the saved signature; it never silently creates a replacement trade.
Pending trade and owner-operation reconciliation continues after mode changes,
strategy disablement or session-key rotation.

Worker shutdown cancels new admission and broadcast, including work queued
behind a database lock. If cancellation arrives after the signed request was
committed, that request remains pending for recovery. Cancelling an in-flight
send cannot prove it missed the network; the worker still reconciles its saved
signature rather than issuing a replacement.

Finalized settlement binds the saved signed bytes, signatures, loaded lookup
addresses, slot, transaction status, program-event invocation stack, token
programs/owners/mints, balance deltas and actual fee. A matching text log from
another program is not execution evidence. Successful exits allocate cost basis
exactly; network fees are tracked separately in lamports rather than silently
converted into USDG profit or loss. Failed finalized transactions record their
actual network fee and no asset fill.

A missing receipt is **not** proof of failure. An expired submission becomes
terminal only when finalized state proves its vault sequence did not advance
and either the signed blockhash lifetime ended or the session epoch changed.
That proves no successful swap; it does **not** prove that no failed attempt
paid a fee. Such records retain `feeLamports: null`, an unresolved-fee count and
a reserved fee allowance. The UI identifies incomplete fee totals. Contradictory
or insufficient evidence leaves the request pending and holds new exposure.
Owner-operation expiry uses its own finalized lifetime and unchanged-state proof.

The live book starts with USDG only. A fresh finalized increase in USDG with
unchanged WSOL and no unresolved operation is booked once as capital-in, not
profit, and raises the high-water mark. Direct WSOL deposits have no established
cost basis and are rejected by the trading book. Unexplained balance changes
hold trading until reconciled.

The app supports owner-signed revocation, USDG/WSOL withdrawal and resuming
buys. Withdrawals return tokens to the owner's canonical account and remain
available with expired or revoked session authority. Finalized withdrawals
advance the on-chain sequence and are booked once as capital-out; WSOL basis
is removed proportionately without inventing a sale. The UI returns **wrapped
SOL** and does not unwrap it to native SOL.

The program and shared core ABI additionally expose `withdraw_sol` /
`buildWithdrawSolanaNativeInstruction` to recover native SOL sent to the vault,
preserving its rent reserve and history. This native recovery operation is
**not yet exposed through the app owner API or UI**. No operation closes and
recreates the vault to reset its sequence or spend history.

## Paper use and autonomous worker

In `/solana`, verify the wallet, save paper limits and create a simulated
portfolio. Preview and trade actions use real provider quotes; paper fills use
the quoted minimum output. Results are marked simulated and exclude network
fees and rent. Existing paper books cannot be refilled or reset. Repeating a
committed request returns its stored receipt, including when providers are
offline or the current policy has expired.

The local CLI is a separate simulation tool. Its `--owner` is only a book label,
not wallet proof or a funding address, and the CLI refuses hosted mode. Its
SQLite file is `MERRYMEN_HOME/solana-paper.sqlite` (default `~/.merrymen`):

```sh
npm run check:solana-rpc
npm run solana:paper -- --help
npm run solana:paper -- init --owner YOUR_PUBLIC_KEY
npm run solana:paper -- status --owner YOUR_PUBLIC_KEY
npm run solana:paper -- trade --owner YOUR_PUBLIC_KEY \
  --input 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH \
  --output So11111111111111111111111111111111111111112 \
  --amount-raw 1000000 --request-id paper-buy-001
```

The default local book has 1,000 simulated USDG, 25 USDG per trade, 100 USDG per
rolling day, 20 operations per day, a 10% drawdown limit and seven-day expiry.
`merrymen solana-paper ...` exposes the same commands when configuration is in
the process environment. Reuse a request ID after interruption.

The dashboard's autonomous strategy maintains a chosen USDG/WSOL allocation,
with a rebalance threshold, maximum USDG per trade and check interval. It sizes
using executable exit quotes and integer arithmetic, re-quotes partial exits,
and never raises a cap to obtain a fill. Strategy interval IDs are durable, and
settings/enablement revisions are checked again at admission. Saving a strategy
does not start a worker; the dashboard distinguishes a saved strategy waiting
for a heartbeat from a connected worker.

```sh
npm run start:solana
# Equivalent CLI entry point with environment already supplied:
merrymen solana-agent
```

This is a separate worker from the RH fleet. In the container, the explicit
role is `MERRYMEN_START=start:solana`. Hosted operation uses the shared database;
it does not fall back to an ephemeral SQLite file. The hosted deploy guard
requires the matching Solana service identity, `DATABASE_URL` and the expected
Docker image marker, and rejects using the configured RH fleet service. See
[hosted deployment](hosted-deploy.md) for role provisioning. This documentation
records configuration requirements; no service has been deployed by this work.

## Private configuration and deployment verification

[`.env.solana.example`](../.env.solana.example) contains placeholders only. The
supplied Helius and Jupiter credentials are in the ignored, mode-0600 local
`.env.solana.local`, excluded from Docker contexts. Keep Solana RPC credentials
server-side: never put them in `NEXT_PUBLIC_`, the browser chain registry or
Robinhood's `MERRYMEN_RPC_MAINNET` setting. RPC attempts use deadlines, response
bounds, redacted errors and no redirects. Each endpoint verifies the full
Solana mainnet genesis hash. An optional fallback must use a different hostname
and independently verify mainnet.

The Solana npm commands load that private file. For the local dashboard, run
the following from the repository root so its server receives the same values
(the normal dashboard authentication configuration is still required):

```sh
node --env-file=.env.solana.local node_modules/next/dist/bin/next dev web -H 127.0.0.1 -p 3100
```

Hosted web and worker services receive these values through their secret
environments; the private file is not part of their image.

The app and Solana worker share `DATABASE_URL` in hosted mode. Local app/worker
storage is `MERRYMEN_HOME/solana-accounts.sqlite`, using WAL, full synchronization
and owner-only file permissions; it is separate from the local paper CLI book.
PostgreSQL and SQLite transactions enforce the same tenant/policy/admission
boundaries. Backups must preserve the durable journals and encrypted session
records; the encryption key belongs in the secret environment, not the database.

Live configuration additionally requires an explicit vault program ID,
`MERRYMEN_SOLANA_VAULT_SHA256`, `MERRYMEN_STORE_DEK`, a distinct
`MERRYMEN_SOLANA_FEE_PAYER_SEED`, and fee limits. Both key settings are canonical
base64 encodings of 32 bytes. There is no owner-key configuration. Default
execution fee-plus-rent allowance is 5,000,000 lamports and compute-unit price
is zero micro-lamports; the executor validates the estimate and actual receipt
against the configured limits.

The program verifier rejects an upgrade authority and checks executable bytes
against the configured SHA-256. Its hash covers the **entire ProgramData
executable region after the 45-byte loader metadata, including allocation
padding**. A local `.so` hash is interchangeable only for an exact-sized
allocation. A release must verify the reviewed artifact bytes and any known
zero padding before recording that region hash. The program ID declared in
`contracts/solana` is a local test identity, not an existing production deployment.
Account layout version 2 (the WSOL input caps) changed the program, so every
artifact and region hash recorded before it is obsolete.

## Verification evidence and remaining release gates

Focused checks actually run during implementation include the following. These
sets overlap broader repository runs and must not be added into one total:

- Core: 23 paper contract tests and 8 live ABI tests, including canonical integer
  validation, exact quote binding and Buffer/subarray decoding.
- Python: 99 focused identifier/backstop tests passed against the shared
  fixtures, including valid all-letter public keys and redacted refusals.
- Custody: 8 native Rust tests and 9 SBF/runtime checks. The runtime uses the
  compiled custody program and real bundled SPL/Token-2022/ATA programs with a
  mock Jupiter processor. It covers actual token CPIs, authority exclusion,
  rollback, sequence/session replay, owner recovery, System-account prefunding
  below/above ATA rent and WSOL donations with unsynced lamports. Actual owner,
  vault and fee-payer balance changes match the settlement refund formula. It
  does not establish compatibility with a real Jupiter fill.
- Paper: market/RPC, ledger, service/command and CLI subprocess tests covering
  unsafe/stale data, lock waits, concurrent processes, crash-after-commit,
  rollback, integer cost basis, exits and offline retries.
- Live: executor, live-market, live-RPC and shared-store tests passed,
  including 6 tests against a real temporary PostgreSQL instance. Coverage
  includes real versioned transaction signatures, ALT binding, persist-before-
  send, lost responses, finalized provenance, unknown fees and owner flows.
  Shutdown regressions cover in-flight status/quote reads, risk assessment,
  database-lock waits, durable commit, genesis verification and fetch abort.
- Web: 79 focused authentication, wallet-binding, route, rendered-UI, Privy and
  navigation tests passed. A further 127 startup/container/deploy-guard and
  creation-consent race checks passed. A production Next build passed during
  the focused work. Final worker, web, browser and SDK type checking also passed.

Final `npm test` on 2026-10-18 ran 23,610 tests: **23,569 passed, 1 failed,
6 cancelled and 34 skipped**. All Solana cases passed, including the last
shutdown regressions. The broad run was not clean: an existing orchestrator
subprocess exceeded its 10-second timeout, and an existing Telegram suite's
6-second setup wait timed out, cancelling its six cases. Both test files were
then rerun unchanged, sequentially, together with the admission-invariant tests:
**53 passed, 0 failed, 0 cancelled, 1 optional PostgreSQL test skipped**. Their
unchanged successful rerun is consistent with load-related timeouts; it does
not erase the original full-run result. No timeout or risk limit was relaxed.

Read-only Helius mainnet diagnostics and Jupiter quote/instruction requests
succeeded. An isolated paper USDG → WSOL → USDG round trip and offline replay
used real quotes. These operations made no public transaction submission and
establish neither live-fill performance nor trading profitability.

Release still requires:

1. Review and audit of custody, ABI, execution, authentication and accounting;
   integration with current mainline and a clean CI run in the release environment.
2. Reproducible artifact verification, explicitly authorized immutable program
   deployment, production ProgramData hash verification and service provisioning.
3. A configured independent RPC fallback, production Privy Solana availability,
   encrypted shared storage/backups and a separately funded fee payer.
4. Owner-authorized funding and a small acceptance canary using real Jupiter,
   followed by restart/outage, full-exit, withdrawal/revocation and expiry tests.
5. Measured quote-to-finality latency, fill rate, actual slippage, network fees,
   rent and recovery reliability against equivalent RH workloads and caps before
   claiming it is better.
6. Further product work for general-token live trading, discovery/Brain strategy
   integration, X/Telegram/MCP/mobile parity, owner bridging and native-SOL UI
   recovery. The current autonomous strategy is the explicit USDG/WSOL rebalancer.

The current adapters use Jupiter Swap v1 for its quote context slot and pinned
CPI ABI. Any provider migration must retain equivalent freshness, instruction
binding and accounting evidence; it is a release dependency to verify rather
than an assumption of indefinite v1 availability.
