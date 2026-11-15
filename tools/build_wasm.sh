#!/usr/bin/env bash
# Rebuild web/src/lib/argon2.wasm from crates/argon2-wasm and run the RFC 9106 vector test first.
set -euo pipefail
cd "$(dirname "$0")/../crates/argon2-wasm"
cargo test --release
cargo build --release --target wasm32-unknown-unknown
target="${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/evolve_health_argon2.wasm"
out="../../web/src/lib/argon2.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext "$target" -o "$out"
else
  cp "$target" "$out"
fi
sha256sum "$out"
