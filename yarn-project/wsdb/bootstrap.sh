#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

(cd "$ROOT" && node --experimental-strip-types --experimental-transform-types --no-warnings \
  ipc-codegen/src/generate.ts \
  --schema barretenberg/cpp/src/barretenberg/wsdb/wsdb_schema.json \
  --lang ts \
  --client \
  --out yarn-project/wsdb/src/generated \
  --prefix Wsdb \
  --strip-method-prefix \
  --package yarn-project/wsdb \
  --package-name @aztec/wsdb \
  --binary-name aztec-wsdb \
  --package-transports uds,shm \
  --ipc-runtime-dependency portal:../../ipc-runtime/ts)
