#!/usr/bin/env bash
# zk-arena — grade one PR on this runner: base branch tip AND the PR's merge result,
# paired on the same VM (cancels the hardware lottery on both architectures).
#
#   zk-arena/pr-grade.sh <pr-number> [runs]
#
# Expects: zk-arena/setup.sh already ran (frozen verifier, nargo, clang, ccache);
# the repo checked out at the zk-arena branch tip (= the base being defended);
# refs pr-head / pr-merge fetched by the workflow.
#
# Outputs in ci-out/:
#   policy.json   touched-files policy verdict (computed from TRUSTED context)
#   base.json     grade of the branch tip
#   cand.json     grade of the PR merge result
#   meta.json     shas + machine label
set -uo pipefail

PR="${1:?pr number required}"
RUNS="${2:-5}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARENA_DIR="$REPO_DIR/zk-arena"
OUT="$REPO_DIR/ci-out"
mkdir -p "$OUT"

export BASELINE_BB="$HOME/bb-baseline/bb"   # the FROZEN verifier (original pinned base)
export NARGO_BIN="$HOME/.nargo/bin/nargo"
export CCACHE_DIR="$HOME/.ccache" CCACHE_MAXSIZE=4G
export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if [ -z "${ZKARENA_MACHINE:-}" ]; then
  case "$(uname -m)" in
    aarch64|arm64) ZKARENA_MACHINE="gh-arm64/Cobalt-100" ;;
    x86_64)
      cpu=$(grep -m1 'model name' /proc/cpuinfo | grep -oE 'EPYC [0-9a-zA-Z]+|Platinum [0-9a-zA-Z]+|Xeon [0-9a-zA-Z]+' | head -1 | tr ' ' '-')
      ZKARENA_MACHINE="gh-x64/${cpu:-unknown-cpu}" ;;
    *) ZKARENA_MACHINE="gh/$(uname -m)" ;;
  esac
fi
export ZKARENA_MACHINE

cd "$REPO_DIR"
BASE_SHA=$(git rev-parse HEAD)
HEAD_SHA=$(git rev-parse pr-head)

# Construct the candidate merge LOCALLY instead of trusting GitHub's pull/N/merge ref:
# that ref is recomputed lazily and can stay stale for minutes after the base branch moves
# (merge + record-bot commit), which previously made the policy diff blame the PR for the
# base's own files. A local merge is always against the exact tip being graded.
git config user.name "zk-arena-grader"
git config user.email "grader@users.noreply.github.com"

# CI checkouts are shallow (depth 1): deepen until the tip and the PR head share a merge
# base, or the local merge below would fail with "refusing to merge unrelated histories".
attempt=0
until git merge-base "$BASE_SHA" pr-head >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 12 ]; then
    echo "FATAL: no common history between the tip and PR #$PR's head after deepening — is the PR based on this branch?" >&2
    exit 4
  fi
  echo "deepening history to find the merge base (attempt $attempt)..."
  git fetch -q --deepen=100 origin zk-arena "pull/$PR/head" || true
done

git checkout -q -B grade-candidate "$BASE_SHA"
if ! git merge --no-ff --no-edit -q pr-head; then
  echo "FATAL: PR #$PR does not merge cleanly into the current tip ($BASE_SHA) — rebase the PR and re-run." >&2
  exit 4
fi
MERGE_SHA=$(git rev-parse HEAD)
git checkout -q "$BASE_SHA" 2>/dev/null || git checkout -q --detach "$BASE_SHA"
jq -n --arg pr "$PR" --arg base "$BASE_SHA" --arg head "$HEAD_SHA" --arg merge "$MERGE_SHA" --arg machine "$ZKARENA_MACHINE" \
  '{pr: $pr, baseSha: $base, headSha: $head, mergeSha: $merge, machine: $machine}' > "$OUT/meta.json"

# ---- Policy check (TRUSTED: computed here from refs, not in PR-controlled context) ----
# A submission may only touch the prover sources. Everything else (grader, workflows,
# problem assets, build config) is maintainer-owned.
ALLOWED='^barretenberg/cpp/src/barretenberg/'
TOUCHED=$(git diff --name-only "$BASE_SHA" "$MERGE_SHA")
VIOLATIONS=$(echo "$TOUCHED" | grep -vE "$ALLOWED" || true)
if [ -n "$VIOLATIONS" ]; then
  jq -n --arg v "$VIOLATIONS" '{ok: false, violations: ($v | split("\n"))}' > "$OUT/policy.json"
  echo "POLICY VIOLATION — files outside barretenberg/cpp/src/barretenberg/:" >&2
  echo "$VIOLATIONS" >&2
  exit 3
fi
jq -n --arg t "$TOUCHED" '{ok: true, touched: ($t | split("\n") | map(select(. != "")))}' > "$OUT/policy.json"

build_bb() { # $1 = worktree dir
  cd "$1/barretenberg/cpp"
  cmake --preset default >/dev/null 2>&1 || cmake --preset default
  set +e
  cmake --build --preset default --target bb 2>&1 | tee /tmp/bb-build.log | grep --line-buffered -E '^\[[0-9]+/[0-9]+\]' | sed -n '1~100p'
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" != 0 ]; then echo "build FAILED:"; tail -100 /tmp/bb-build.log; return 1; fi
  cd "$REPO_DIR"
}

# ---- Build + grade the BASE (branch tip) ----
echo "== building base ${BASE_SHA:0:10} =="
git worktree add --detach /tmp/wt-base "$BASE_SHA"
build_bb /tmp/wt-base || exit 1
echo "== grading base ($RUNS runs) =="
node "$ARENA_DIR/grade.mjs" --stack=base --bb=/tmp/wt-base/barretenberg/cpp/build/bin/bb \
  --runs="$RUNS" --boards="$OUT/scratch-boards" --json="$OUT/base.json" 2>&1 | tee "$OUT/base-transcript.log"
[ "${PIPESTATUS[0]}" = 0 ] || { echo "base grading failed" >&2; exit 1; }

# ---- Build + grade the CANDIDATE (PR merged into the tip) ----
echo "== building candidate (merge ${MERGE_SHA:0:10}) =="
git worktree add --detach /tmp/wt-cand "$MERGE_SHA"
build_bb /tmp/wt-cand || exit 1
echo "== grading candidate ($RUNS runs) =="
node "$ARENA_DIR/grade.mjs" --stack=candidate --bb=/tmp/wt-cand/barretenberg/cpp/build/bin/bb \
  --runs="$RUNS" --boards="$OUT/scratch-boards" --json="$OUT/cand.json" 2>&1 | tee "$OUT/cand-transcript.log"
[ "${PIPESTATUS[0]}" = 0 ] || { echo "candidate grading failed" >&2; exit 1; }

git worktree remove --force /tmp/wt-base || true
git worktree remove --force /tmp/wt-cand || true
echo "pr-grade complete"
