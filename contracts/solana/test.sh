#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cargo test --locked --manifest-path "$script_dir/Cargo.toml" --lib
cargo-build-sbf --manifest-path "$script_dir/programs/merrymen-vault/Cargo.toml" --sbf-out-dir "$script_dir/target/deploy" -- --locked
BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked --manifest-path "$script_dir/runtime-tests/Cargo.toml" --test custody -- --ignored
