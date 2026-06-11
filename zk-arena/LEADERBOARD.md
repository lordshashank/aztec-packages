# zk-arena — leaderboard (rolling champion)

**The branch is the leaderboard.** Every merged PR improved the prover beyond the noise margin
of the official paired grading (or was a maintainer-approved tradeoff) — the history of the
`zk-arena` branch *is* the audit trail, and `git log -- barretenberg` tells the full story.

**Task (frozen):** `hard2pow21` — prove the pinned 1,501,711-gate (2^21) UltraHonk circuit,
single-threaded, native. Soundness is anchored to the **frozen verifier + VK** built from the
original pinned base `7e94c2c0e3` — every candidate proof must verify under it, forever.

Each row = one merged submission, graded **paired against the branch tip it merged into** on
two architectures (arm64 absolute seconds on the homogeneous Cobalt-100 fleet; x86 as a
time ratio to the paired base on the same VM). Δ columns are vs that base, not vs the origin.

| date | change | author | arm64 time | Δ time | arm64 RSS | Δ RSS | x86 ratio | verdict | merge |
|---|---|---|---|---|---|---|---|---|---|
| 2026-06-10 | original pinned base (frozen verifier/VK anchor) | — | 63.74 s | — | 1973 MiB | — | — | origin | `7e94c2c0e3` |
| 2026-06-10 | opt-next: MSM routing, Shplonk fusion, PK staging *(pre-rolling flow)* | @lordshashank | 56.57 s | −7.17 s | 1889 MiB | −84 MiB | 0.875 | accept | — |
| 2026-06-11 | opt-next2: asm on all aarch64, signed-Booth MSM, prefetch, consume-polys, split pow table *(pre-rolling flow)* | @lordshashank | 45.60 s | −10.97 s | 1844 MiB | −45 MiB | 0.861 | accept | — |
| 2026-06-11 | opt-next3: σ/id u32 sidecars, flat copy cycles, selector trims *(pre-rolling flow; = initial state of this branch)* | @lordshashank | 45.04 s | −0.56 s | 1464 MiB | −380 MiB | 0.853 | accept | — |
<!-- ROWS-ABOVE: record.mjs inserts new rows directly above this line -->

Cumulative vs the original base: **−29.3% prove time, −25.8% peak RSS** (arm64 official).

_Official numbers are produced only by the `zk-arena-grade` workflow on GitHub-hosted runners;
the per-PR verdicts (full JSON, margins, σ) live as comments on the merged PRs and in
`zk-arena/log.jsonl`. Rows marked pre-rolling-flow were graded under the previous
patch-based arena ([zk-prover-arena](https://github.com/lordshashank/zk-prover-arena),
archived) on the same runners and budgets._
