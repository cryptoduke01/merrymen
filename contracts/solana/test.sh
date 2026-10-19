#!/usr/bin/env bash
# Native unit tests, the pinned SBF build (build.sh checks agave 2.3.13 / platform-tools
# v1.48 and compares with build-manifest.json), then the runtime tests against that artifact.
# Extra arguments go to cargo-build-sbf, for example --offline.
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
BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$script_dir/runtime-tests/Cargo.toml" --test custody -- --ignored
