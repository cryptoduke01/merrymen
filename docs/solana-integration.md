# Solana, side by side with Robinhood Chain

Milla, 2026-10-16: "integrate Solana completely: bots, agents, X trading,
everything; if possible the same stables should work for both". She approved
the recommended design below. This file is the plan of record; each phase
lands as its own reviewed PR.

## The shape: one control plane, two data planes

Everything that decides or limits stays shared and chain-blind:
- strategies (Trencher, Strategist), Brain, policy caps;
- admission, budgets, journal, epochs, anchors, high-water mark, fees;
- the paper boundary.

Everything that touches a chain sits behind a per-chain adapter:
- custody and wallets;
- the executor and its decode fence;
- receipt decoding and scanners;
- venues and pricing;
- the fee model;
- explorer links;
- repair tools.

The repo did this once already for the Robinhood broker rail (`rh:` agent ids,
OrderExecutor as a sibling); Solana copies that shape.

## Decisions taken

| Question | Decision |
|---|---|
| Stable | Paxos USDG on both chains: the same issuer, unit and 6 decimals, with one book per chain. Solana mint `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` (Token-2022, verified on chain 2026-10-16). |
| Moving USDG between chains | Owner only, through Paxos's own LayerZero OFT burn/mint. Never an agent permission. Booked as capital-out on one book and capital-in on the other, linked by the LayerZero GUID. |
| Custody on Solana | Our own `merrymen_vault` Anchor program, immutable per version, mirroring TrencherVault. Details below. |
| Agents | One chain per agent. An owner can run a Robinhood agent and a Solana agent side by side. Solana agent ids are `sol:<owner pubkey>`. |
| Who owns a Solana agent | The owner's Privy Solana embedded wallet, bound to the existing tenant. |
| Caps | Per chain, with the same numbers on each. The UI says plainly that there are two ceilings. |
| Live consent | Per chain. A Robinhood consent or deposit never arms Solana. |
| Venues | Chosen after the P3 spike: Jupiter under swap-authority isolation if it fits, otherwise direct CPIs. The pump.fun curve is valuation-only in v1. |
| Token-2022 coins with freeze, permanent delegate, a hook or a fee | Buys refused; sells never blocked. |
| Fees and rent | The house fee payer pays fees within bounds and is an authority on nothing. The owner funds rent; full exits close accounts and return the rent. |
| MEV | No Jito tips in v1. Slippage stays at a 100 bps maximum and is never raised to get fills. |

### Custody details

The vault is a PDA per owner.
- **Session key:** registered by an owner-signed `create_session`, with on-chain per-trade, daily, ops/day and breaker state.
- **Replay protection:** `expected_seq`.
- **Swap-authority isolation:** a route can only ever touch `amount_in`.
- **Owner-only operations:** withdraw, recover and `revoke_all`.

USDG on Solana carries issuer powers: freeze, permanent delegate, and fee and
hook authorities (unset today). Every amount is booked from balance deltas,
and buys pause by name if a fee or hook is ever turned on.

## Phases

| Phase | What | Live money |
|---|---|---|
| P0 | Fail-closed guardrails and the shared identity layer (`packages/core/src/ids.ts`): nothing fails open when a Solana id appears, and EVM is byte-identical. | no |
| P1 | Chain-generic seams (ledger evidence, execution rail, market, the `spl-swap` intent, per-chain exec mode, cash registry, multi-agent read model), EVM on today's paths. | no |
| P2 | The Solana data plane and paper agents. Discovery, pools, mint-safety screens, pricing and paper fills; Solana agents in paper; X/Telegram chain-aware; the side-by-side app. | no |
| P3 | The `merrymen_vault` program: CPI spike, fork harness, verifiable build, devnet, external audit. | no |
| P4 | The live rail, dry-run only. SolanaExecutor (persist before send, drop proof by seq), decode fence, receipt decoder, ledger adapter, owner withdraw/recover/revoke. | no |
| P5 | Mainnet canary: one operator agent, the smallest caps, after the audit and Milla's explicit go. | yes |
| P6 | Rollout: per-chain consent, owner bridging in the UI, mobile, MCP, Telegram trading on Solana. | yes |

## Side by side

Each chain has a look in the registry (`ChainInfo.look`):
- Robinhood is neon green (`#CCFF00` → `#00C805`) with the glyph `R`.
- Solana is the purple-to-teal gradient (`#9945FF` → `#14F195`) with the glyph `◎`.

Every balance, address, link, trade, post and card names its chain.

## What we need from outside

- A Solana RPC provider (Helius, Triton or QuickNode), plus a second, independent one.
- A Jupiter API key.
- Pyth SOL/USD feed ids.
- CoinGecko Pro credits for a `solana` tape.
- Bitquery Solana access.
- Privy: Solana embedded wallets on, and the dev-mode cap lifted in place.
- An Anchor toolchain, a deployer keypair with a few SOL, and `solana-verify`.
- An external Solana audit firm.
- A funded house fee-payer keypair.
- SOL rent floats.
- ETH for LayerZero fees on bridging.
- Milla's review on every phase.
