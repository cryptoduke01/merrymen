# Bounded Solana custody (local source and tests)

This directory contains an actual Anchor 0.32.1 custody program and a shared ABI
in `packages/core/src/solana-live.ts`. It is **not deployed**. The declared public
program ID is a local test identity only. A live runtime must explicitly configure
an immutable deployment, verify its executable bytes against the reviewed SBF
binary hash, and verify the finalized owner/session state before enabling trades.
The runtime hash covers the entire ProgramData executable region after its
45-byte loader metadata, including allocation padding. The local `.so` hash is
the same only for an exact-sized allocation; otherwise the release process must
verify artifact bytes and known zero padding before recording the region hash.
The source does not include a deployment wallet or any owner/session private key.

## Authority and execution

The vault PDA is derived from `["vault", owner]`. Only the owner can initialize,
replace a session, revoke all sessions, clear the breaker or withdraw custody
assets. `withdraw_sol` also recovers native SOL accidentally sent to the vault,
while preserving its rent reserve and permanent sequence/history. Token withdrawals require the owner's canonical token account, remain available
when paused/expired/revoked and increment the sequence to invalidate prepared
swaps. `OwnerWithdrawal` identifies the amount, mint and consumed sequence.

A session is a signing public key with a positive per-trade cap, a
rolling 24-hour USDG cap, a positive per-trade and rolling 24-hour **WSOL input**
cap (lamports, per-trade ≤ daily), at most 96 operations per rolling day, and an
expiry. All of these are owner-signed in `create_session`.
Replacing a session increments its epoch; it preserves the sequence, debit
history and breaker. Revocation removes session authority and sets the breaker.
The session can set the sticky breaker but only the owner can clear it. A breaker
blocks buys; exits remain subject to all caps, expiry, sequence and output checks.
There is no on-chain portfolio price oracle: drawdown valuation is a worker
responsibility and must fail closed when marks are stale or unproven.

Every swap binds the expected sequence and session epoch. A distinct fee payer
pays the transaction and temporary-account rent; it never receives custody
signing authority. The program transfers exactly the authorized amount to the
input ATA of a per-sequence PDA `["swap", vault, seq_le_u64]`. That PDA is the
**only** signer forwarded to a Jupiter CPI. Vault state, owner, session, fee payer,
source custody ATA, any token account owned by the vault owner (including the
owner refund ATA, whether or not it was passed), and other custody-owned token
accounts are forbidden in the CPI account list. The single allowed custody token
account is the destination ATA, which Jupiter can credit but cannot debit
without the vault signer.

The program pins Jupiter's v6 program ID and accepts only its ExactIn
`sharedAccountsRoute` discriminator, bound input, output floor, zero platform fee
and at most 100 bps slippage. Jupiter validates the remainder of the route data.
The input amount exposed to CPI is bounded independently of route internals.
Output is measured from actual custody balance deltas. Unspent input returns to
the vault, the temporary ATA closes and refunds its rent to the fee payer. Prior
unsolicited deposits to the temporary ATA are refunded to the owner’s canonical
input ATA before measuring input, so a publicly predictable address does not create a donation denial of
service and a donation never counts as trade input. The owner refund ATA is an
optional account (the client passes the program ID to leave it out): it is
needed only when such a donation is waiting. An owner who closes their own USDG
or WSOL account, for example by unwrapping WSOL in a wallet, therefore no longer
blocks buys or exits. If a donation is waiting and the refund account is absent,
the swap fails closed with `RefundAccount` (6010); the fee payer never creates
owner accounts. Success increments the sequence and emits `SwapExecuted`; any failed
check rolls back the CPI, balances, debit history and sequence atomically.

Buy budgets conservatively charge the full authorized USDG input even when dust
returns. Sells are bounded on input: the full authorized WSOL input is charged
against the WSOL caps, so a session-chosen dust quote cannot sell more than the
owner signed for, whatever it is priced at (the 2026-10-18 audit's VAULT-1, where
one sell emptied the position for 1 micro-USDG). Sell proceeds are still charged
against the USDG caps too, with a preflight check of the guaranteed minimum and a
final atomic check of actual proceeds. Both directions consume the global
operation budget. Session replacement never replenishes any of them.

Account layout version 2 (2441 bytes) carries the WSOL caps and a `wsol` field on
every debit. The program refuses to execute against a version 1 vault, and the
TypeScript decoder refuses to read one. Changing the layout changed the program:
every artifact hash recorded before it (`9bb352ad…`, `53c9a7ba…`, `ee04ea0e…`,
`dfb7617c…`) describes a binary that will never ship.

## Initial live asset scope

This first live version supports **USDG ↔ wrapped SOL only**. USDG is pinned to
its mainnet Token-2022 mint with six decimals. Wrapped SOL is pinned to the
classic SPL token mint with nine decimals. It does not yet authorize arbitrary
memecoins or other SPL/Token-2022 assets. General-token support requires a new
reviewed program version and matching runtime checks.

USDG's known issuer-controlled mint/freeze/permanent-delegate and confidential
configuration authorities are an explicit cash-token trust assumption. Metadata
and known non-fee issuer extensions are accepted; active or scheduled nonzero
transfer fees, configured transfer hooks and unknown extensions fail closed.
This assumption does not permit arbitrary token issuers. Custody/source/output
accounts must be unfrozen and have no delegate or close authority.

## Local verification

```
PATH="<agave 2.3.13>/bin:$PATH" contracts/solana/test.sh   # add --offline without network
node --import tsx --test packages/core/src/solana-live.test.ts
```

`test.sh` runs the native unit tests, then `build.sh`, then the runtime tests against the
artifact it just built. `build.sh` is the only supported build recipe:

- It requires `cargo-build-sbf` 2.3.13 and platform-tools v1.48 (rustc 1.84.1-dev, LLVM
  19.1.7, anza-xyz/rust `293a1b6c`) and always passes `--tools-version v1.48 --arch v0`
  and `--locked`. Any other toolchain, an `lto` setting, or ambient `RUSTFLAGS`,
  `CARGO_PROFILE_*` or `CARGO_TARGET_*` overrides stop the build. So does a
  `.cargo/config.toml` (or legacy `.cargo/config`) in the program's directory, in any
  directory above it, or above the directory `build.sh` runs from, other than
  `CARGO_HOME`'s own: cargo applies such a file to the vault build (a `[profile.release]`
  table there overrides the workspace's `overflow-checks`), and the source digest does
  not cover it. A pull request that adds one at the repository root or in `contracts/`
  starts the vault jobs (`scripts/ci/solana-paths.mjs`), so CI meets this refusal on the
  pull request itself.
- It resolves `CARGO_HOME` and the source directory to physical paths. cargo-build-sbf
  remaps rustc's canonical working directory, so a symlinked `CARGO_HOME` (macOS `/tmp`)
  left absolute registry paths in the binary and changed its hash (audit GAP4-2).
- It compares the artifact with `build-manifests/<uname -s>-<uname -m>.json`. Same source
  and a different artifact is an error. `build.sh --record` builds a second copy of the
  source in another directory, requires identical bytes, and writes that host's
  manifest: source digest, declared program ID, toolchain, artifact bytes and sha256.
  Platform-tools embeds its own build paths, so macOS and Linux artifacts differ; the
  release artifact must come from the pinned Linux CI build and its own manifest.
- `build.sh --source-digest` prints the digest of the reviewed inputs (workspace and
  program manifests, `Cargo.lock`, `build.sh` and the program sources). The TypeScript
  suite recomputes it and fails while any recorded manifest is stale.

The deployed ProgramData region hash equals the manifest sha256 only for an exact-size
allocation; otherwise hash the artifact followed by its zero padding (see above).

## CI and the release artifact

`solana · test` in `.github/workflows/ci.yml` installs agave 2.3.13 and platform-tools
v1.48, each checked against the size and SHA-256 in `scripts/ci/solana-toolchain.env`
before it is unpacked, runs `test.sh`, checks that every runtime test ran, and records
the artifact (`merrymen_vault.build.json`: program ID, SHA-256, toolchain and the run
that built it). `solana · rebuild` builds the same source again from `git archive` on
another runner, and `app` requires the two hashes to be equal. Both jobs build only when
a pull request changes a Solana-relevant path (`scripts/ci/solana-paths.mjs`; it counts
`.cargo/`, `rust-toolchain` and `.gitattributes` at the repository root and in
`contracts/` too, because cargo and git apply them to the vault's build and source);
pushes to main and manual runs always do.

`solana · test` then runs `build.sh --record` and checks that the manifest it writes,
`build-manifests/Linux-x86_64.json`, is for the artifact the runtime tests ran against.
Before the upload it compares that manifest with the committed one
(`scripts/ci/solana-linux-manifest.mjs report`), writes the outcome into the record, and
names the artifact from it (below). The job's last step fails on the outcome, after the
upload, so a run whose manifest differs still hands it over. It fails when a committed
Linux manifest exists and differs from that pinned Linux build, and when the commit under
test deleted the manifest its first parent has (a pull request's base, or the commit
before a push): once committed, it is replaced by the next reviewed one, never deleted.
While none is committed on either side it only reports the recorded values. One case
fails earlier: a committed Linux manifest with this build's source digest but another
artifact. `build.sh`, run by `test.sh` in the Test step, stops on it ("same source,
different artifact"), so the job fails before the comparison and the upload, and hands
over no new manifest. The reviewed source did not change, so the toolchain or the build
environment did: investigate that rather than commit a new manifest.

To commit the first one, take the artifact from a run whose `app` check passed, check
that the manifest's `source.digest` equals `build.sh --source-digest` at that commit and
its `artifact.sha256` equals the tested and rebuilt hashes in `app`'s log, and commit the
file unchanged. `app` prints both hashes before it checks any result, so they are in its
log on a failing run too; the `solana · test` and `solana · rebuild` step summaries carry
them as well. From then on a program change needs a new Linux manifest as well: its pull
request fails (this step, and the TypeScript manifest test) until the manifest that run
uploaded is committed. Check it against `solana · rebuild`'s hash the same way; the next
run must then pass, which shows CI reproduced it.

A release comes only from a CI run on `refs/heads/main` (a push to main, or a manual run
on main) whose pinned Linux build matched the committed Linux manifest and whose `app`
check passed. `solana · test` uploads before `app` has compared the rebuild's hash, and
before the rest of the run has passed or a newer push has cancelled it, so it names such
a run's bytes `merrymen-vault-sbf-candidate-unconfirmed-<commit>-run<id>.<attempt>`, never
a release. `solana · release` needs `app` and runs only when it passed; for a candidate
it uploads `merrymen-vault-release-<commit>-run<id>.<attempt>`, a record
(`merrymen_vault.release.json`) naming the candidate artifact and the SHA-256 that
`solana · test` tested and `solana · rebuild` reproduced. That record is the release
verdict: take the bytes from the artifact it names (`target/deploy/merrymen_vault.so`)
and check that they hash to its `sha256`. A candidate without a release record in the same
run is not a release. The first release needs a committed Linux manifest: until one is
committed, every artifact is `not-a-release`. Every other artifact is named
`merrymen-vault-sbf-not-a-release-…`: every pull request's, and every one whose build
differs from the committed manifest or whose commit deleted it, a run on main included.
The build record's `release` and `linuxManifest` fields say why. CI never runs on a tag
push, and a manual run on a tag or another branch is not a release. The names and records
are written by the run itself, so confirm the run's event, branch and commit on GitHub,
and that its `app` check passed, before using it.

The TypeScript suite also writes `runtime-tests/fixtures/ts-instructions.json` from the
shared ABI builders (`MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1` rewrites it) and fails while it
is stale. `custody.rs` executes those exact bytes and account metas against the compiled
program, so the TypeScript ABI is tested against the real program, not only Anchor's
Rust client.

The runtime tests are explicitly ignored by plain `cargo test` because Anchor
0.32.1 cannot run its CPIs in the native processor. The separate runtime-tests
workspace keeps the current host SVM dependencies out of the SBF Rust1.84 build. `test.sh` builds the SBF
artifact and runs these required tests. A missing artifact is an error.

The runtime harness uses generated or fixed-seed, unfunded local identities, synthetic
token accounts (including real Token-2022 mints with extensions), ProgramTest’s bundled real SBF SPL/Token-2022/ATA programs and a pinned
mock Jupiter processor. It exercises SPL/Token-2022 CPIs,
authority exclusion, atomic rollback, sequence replay and session replacement.
It is not evidence of a mainnet Jupiter fill. An actual mainnet deployment,
external security review, production immutable-binary verification and an
owner-authorized funded acceptance trade remain separate release gates.
