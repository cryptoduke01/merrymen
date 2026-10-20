#!/usr/bin/env bash
# Native unit tests, the pinned SBF build (build.sh checks agave 2.3.13 / platform-tools
# v1.48 and compares with this host's build manifest), then every runtime test against
# that artifact: the custody suite and the owner recovery transactions.
# Extra arguments go to cargo-build-sbf, for example --offline. CI passes none, so its
# build uses exactly build.sh's pinned flags, which scripts/ci/solana-ci.test.mjs holds
# equal to scripts/ci/solana-toolchain.env.
#
# The runtime tests are #[ignore]d so a plain `cargo test` without the artifact skips
# them. --include-ignored runs them whether or not they are marked, so a dropped
# #[ignore] can never make one skip; CI also counts that every one ran
# (scripts/ci/solana-runtime-tests.mjs).
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
mkdir -p "${CARGO_HOME:-$HOME/.cargo}"
CARGO_HOME="$(cd -- "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
export CARGO_HOME
offline=()
for arg in "$@"; do
  if [ "$arg" = "--offline" ]; then offline=(--offline); fi
done
cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$script_dir/Cargo.toml" --lib
"$script_dir/build.sh" "$@"
BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$script_dir/runtime-tests/Cargo.toml" --test custody --test recovery -- --include-ignored
