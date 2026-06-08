#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

declare -A PLATFORMS=(
  ["amd64-linux"]="linux-x64 linux x64"
  ["arm64-linux"]="linux-arm64 linux arm64"
  ["amd64-macos"]="darwin-x64 darwin x64"
  ["arm64-macos"]="darwin-arm64 darwin arm64"
)

version=$(node -p "require('./package.json').version")

for build_dir in "${!PLATFORMS[@]}"; do
  read -r suffix os cpu <<< "${PLATFORMS[$build_dir]}"
  pkg_name="@aztec/wsdb-${suffix}"
  out_dir="packages/wsdb-${suffix}"

  if [ ! -d "build/${build_dir}" ]; then
    echo "Skipping ${pkg_name}: no build/${build_dir} directory"
    continue
  fi

  rm -rf "${out_dir}"
  mkdir -p "${out_dir}"
  cp "build/${build_dir}/aztec-wsdb" "${out_dir}/aztec-wsdb"

  cat > "${out_dir}/package.json" <<EOF
{
  "name": "${pkg_name}",
  "version": "${version}",
  "description": "Native binary for @aztec/wsdb (${suffix})",
  "license": "MIT",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["aztec-wsdb"],
  "preferUnplugged": true
}
EOF
done
