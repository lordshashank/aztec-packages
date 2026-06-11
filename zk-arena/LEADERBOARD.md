# zk-arena — leaderboard (rolling champion)

**The branch is the leaderboard.** Every merged PR improved the prover beyond the noise margin
of the official paired grading (or was a maintainer-approved tradeoff) — the history of the
`zk-arena` branch *is* the audit trail, and `git log -- barretenberg` tells the full story.

## Base reference (frozen)

| | |
|---|---|
| base commit | [`7e94c2c0e32820e25e20d39a426d546dae56a34f`](https://github.com/AztecProtocol/aztec-packages/commit/7e94c2c0e32820e25e20d39a426d546dae56a34f) (aztec-packages `next`) |
| task | `hard2pow21` — pinned 1,501,711-gate (2^21) UltraHonk circuit, **1 thread**, native |
| base score (arm64, official) | **63.74 s / 1973 MiB** (`gh-arm64/Cobalt-100`, 5-run median) |
| base score (x86 reference) | 67.19 s / 2027 MiB (`gh-x64/EPYC-7763` — x86 is ratio-scored, this is context only) |
| soundness anchor | the **frozen verifier + VK** built from this commit must accept every candidate proof, forever |

Each row below = one merged submission, graded **paired against the branch tip it merged into**
on two architectures (arm64 absolute seconds on the homogeneous Cobalt-100 fleet; x86 as a
time ratio to the paired base on the same VM). Δ columns are vs that base, not vs the origin.

| date | change | author | model | arm64 time | Δ time | arm64 RSS | Δ RSS | x86 ratio | verdict | merge |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-06-10 | original pinned base (this branch's starting point) | — | — | 63.74 s | — | 1973 MiB | — | — | origin | `7e94c2c0e3` |
<!-- ROWS-ABOVE: record.mjs inserts new rows directly above this line -->

_Official numbers are produced only by the `zk-arena-grade` workflow on GitHub-hosted runners;
the per-PR verdicts (full JSON, margins, σ) live as comments on the merged PRs and in
`zk-arena/log.jsonl`. The arena's gates, budgets and margins are documented in
[README.md](./README.md) and inherited from the archived
[zk-prover-arena](https://github.com/lordshashank/zk-prover-arena) spec._
