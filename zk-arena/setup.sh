#!/usr/bin/env bash
# zk-arena — provision the official grading environment on a GitHub-hosted runner.
#
# Adapted from the original zk-prover-arena ci/setup.sh for the in-repo flow: the
# repo IS aztec-packages, so the frozen verifier is built from a worktree at the
# ORIGINAL pinned base commit (an ancestor of the zk-arena branch). That verifier +
# the pinned VK anchor the soundness gate forever, regardless of how far the
# champion branch rolls forward.
#
# Layout (consumed by zk-arena/pr-grade.sh):
#   $HOME/bb-baseline/bb       frozen verifier (cache key: ORIGINAL_BASE + toolchain)
#   $HOME/.nargo/bin/nargo     NARGO_BIN
#   $HOME/.ccache              CCACHE_DIR
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARENA_DIR="$REPO_DIR/zk-arena"
# The ORIGINAL pinned base: defines the frozen verifier + VK and all budgets.
ORIGINAL_BASE="7e94c2c0e32820e25e20d39a426d546dae56a34f"
NARGO_VERSION="${NARGO_VERSION:-1.0.0-beta.22}"
LLVM_MAJOR=20

echo "== apt packages =="
sudo apt-get update -qq
sudo apt-get install -y -qq time ninja-build ccache jq >/dev/null

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
sudo env "PATH=$PATH" corepack enable || corepack enable
yarn --version || true

echo "== clang-$LLVM_MAJOR (apt.llvm.org) =="
if ! command -v clang-$LLVM_MAJOR >/dev/null; then
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/llvm.gpg
  echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] http://apt.llvm.org/$CODENAME/ llvm-toolchain-$CODENAME-$LLVM_MAJOR main" | sudo tee /etc/apt/sources.list.d/llvm.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq clang-$LLVM_MAJOR >/dev/null
fi
sudo ln -sf "$(command -v clang-$LLVM_MAJOR)" /usr/local/bin/clang
sudo ln -sf "$(command -v clang++-$LLVM_MAJOR)" /usr/local/bin/clang++
clang --version | head -1

echo "== nargo $NARGO_VERSION =="
if [ ! -x "$HOME/.nargo/bin/nargo" ]; then
  mkdir -p "$HOME/.nargo/bin"
  ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TRIPLE=aarch64-unknown-linux-gnu ;; x86_64) TRIPLE=x86_64-unknown-linux-gnu ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac
  curl -fsSL "https://github.com/noir-lang/noir/releases/download/v$NARGO_VERSION/nargo-$TRIPLE.tar.gz" | tar -xz -C "$HOME/.nargo/bin"
fi
"$HOME/.nargo/bin/nargo" --version

echo "== frozen verifier (pristine ${ORIGINAL_BASE:0:10}) =="
export CCACHE_DIR="$HOME/.ccache" CCACHE_MAXSIZE=4G
export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
if [ ! -x "$HOME/bb-baseline/bb" ]; then
  echo "cache miss — building frozen verifier from ${ORIGINAL_BASE:0:10} (cold: ~15-40 min on 4 vCPU)"
  git -C "$REPO_DIR" fetch -q origin "$ORIGINAL_BASE" 2>/dev/null || true
  git -C "$REPO_DIR" worktree add --detach /tmp/bb-original "$ORIGINAL_BASE"
  cd /tmp/bb-original/barretenberg/cpp
  cmake --preset default >/dev/null
  set +e
  cmake --build --preset default --target bb 2>&1 | tee /tmp/bb-build.log | grep --line-buffered -E '^\[[0-9]+/[0-9]+\]' | sed -n '1~50p'
  build_rc=${PIPESTATUS[0]}
  set -e
  if [ "$build_rc" != 0 ]; then
    echo "=== frozen verifier build FAILED — last 150 lines ==="
    tail -150 /tmp/bb-build.log
    exit 1
  fi
  mkdir -p "$HOME/bb-baseline"
  cp build/bin/bb "$HOME/bb-baseline/bb"
  cd "$REPO_DIR"
  git worktree remove --force /tmp/bb-original
fi
"$HOME/bb-baseline/bb" --version || true

echo "== CRS pre-warm + VK determinism check =="
mkdir -p /tmp/crswarm
"$HOME/bb-baseline/bb" write_vk --scheme ultra_honk -b "$ARENA_DIR/problem/problem.json" -o /tmp/crswarm
cmp /tmp/crswarm/vk "$ARENA_DIR/problem/baseline_vk/vk" || { echo "FATAL: CI-built frozen verifier VK differs from pinned VK — environment/build divergence" >&2; exit 1; }
echo "VK matches pinned baseline VK"

ccache -s | head -6 || true
df -h / | tail -1
echo "setup complete"
