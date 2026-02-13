#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "consumer_bundler_resolution_imports_all_subpaths"
bunx tsc -p test-fixtures/consumer-bundler/tsconfig.json --noEmit

echo "consumer_nodenext_resolution_imports_all_subpaths"
bunx tsc -p test-fixtures/consumer-nodenext/tsconfig.json --noEmit

echo "consumer_types_resolve_from_published_dist_layout"
PACK_FILE="$(npm_config_cache=/tmp/npm-cache npm pack --silent)"
TMP_DIR="$(mktemp -d "$ROOT_DIR/.tmp-packaging.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$ROOT_DIR/$PACK_FILE"
}
trap cleanup EXIT

tar -xzf "$PACK_FILE" -C "$TMP_DIR"

cat > "$TMP_DIR/smoke.ts" <<EOF
import { createRpcClient } from "$TMP_DIR/package/dist/renderer.js";
void createRpcClient;
EOF

cat > "$TMP_DIR/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true
  },
  "include": ["smoke.ts"]
}
EOF

bunx tsc -p "$TMP_DIR/tsconfig.json" --noEmit

echo "pack_dry_run_contains_expected_artifacts_only"
DRY_RUN_OUTPUT="$(npm_config_cache=/tmp/npm-cache npm pack --dry-run 2>&1)"

for required in "README.md" "package.json" "dist/main.js" "dist/renderer.js" "dist/preload.js" "dist/contract.d.ts"; do
  if ! echo "$DRY_RUN_OUTPUT" | rg -q "$required"; then
    echo "Missing required artifact in pack dry-run output: $required"
    exit 1
  fi
done

for forbidden in "src/" "__tests__/" "type-tests/" "test-fixtures/" "scripts/"; do
  if echo "$DRY_RUN_OUTPUT" | rg -q "$forbidden"; then
    echo "Forbidden artifact present in pack dry-run output: $forbidden"
    exit 1
  fi
done
