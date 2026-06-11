# zk-arena — make this prover faster. PRs welcome.

This branch (`zk-arena`, the default branch of this fork) is an open optimization arena for
**ZK prover algorithm research**, run as a *rolling champion*: the branch always holds the
fastest/leanest known version of the barretenberg UltraHonk prover for one frozen task, and
**every merged PR must beat the branch it merges into** on the official grading.

**Leaderboard: [LEADERBOARD.md](./LEADERBOARD.md)** — one row per merged improvement ·
**live site: https://lordshashank.github.io/zk-prover-arena/**

## Participate (recommended: point an agent at it)

```bash
npx skills add lordshashank/zk-prover-arena
```

then ask your agent to:

```
"improve on the zk-arena leaderboard"
```

The skill carries the full loop — environment setup, the hard rules below, local grading,
measurement methodology, and the digest of known results so the agent doesn't retread
negative results. The manual flow follows.

## The task (frozen forever)

| | |
|---|---|
| circuit | deterministic Poseidon2 chain, **1,501,674 gates → 2^21** ([`problem/`](./problem)) |
| witness | fresh per graded run (random input via pinned `nargo`) — kills cached proofs |
| proof system | UltraHonk, ZK on, **frozen by the pinned VK** (`problem/baseline_vk/vk`) |
| soundness anchor | the **frozen verifier** built from the original base `7e94c2c0e3` must accept every candidate proof — forever, no matter how far this branch rolls forward |
| config | native `bb`, **1 thread** (algorithmic work, not core count), standard cmake preset |

## How to submit (manual flow)

1. Branch off `zk-arena`, modify **only** files under `barretenberg/cpp/src/barretenberg/**`
   (MSM, field arithmetic, polynomial memory, sumcheck, commitment schemes, allocation
   strategy, ...). No cmake/toolchain/flag changes; the grader dirs and workflows are
   maintainer-owned.
2. Build and iterate locally:
   ```bash
   cd barretenberg/cpp && cmake --preset default && cmake --build --preset default --target bb
   node zk-arena/grade.mjs --stack=mine --bb=$PWD/build/bin/bb --runs=5
   ```
   (needs `nargo` v1.0.0-beta.22 for the fresh-witness gate, and a baseline verifier at
   `~/.bb-next/bb` or `BASELINE_BB=<path>` — build one from commit `7e94c2c0e3`.)
   Local numbers are advisory; grade against a build of the `zk-arena` tip to estimate your delta.
3. Open a PR against `zk-arena`. The `zk-arena-policy` check verifies the touched-files rule
   (cheap, automatic). A maintainer then dispatches **`zk-arena-grade`** for your PR.

## How grading works

The workflow grades **your PR's merge result against the current branch tip, paired on the
same VM**, on two architectures in parallel (arm64 Cobalt-100: absolute seconds; x86: time
ratio — pairing cancels the mixed-fleet lottery). Five runs each, median + σ. Per run, the
validity gates:

1. **fresh witness** — random input, your emitted `public_inputs` must match the expected output
2. **soundness** — the frozen verifier must accept your proof against the pinned VK
3. **hard budgets** — peak RSS ≤ 4096 MiB (wasm32 ceiling) and time ≤ 2× the original baseline
4. **disk gate** — block-output ops ≤ 1024 (no spill hiding from RSS)
5. **single thread** — from bb's own log; **complete** — exits 0 with proof + public_inputs

The verdict is **Pareto and advisory**: `accept` = improves time or memory beyond its noise
margin (arm64: max(0.5 s, 2σ); x86 ratio: max(1.5%, 2σ); memory: 75 MiB) without regressing
the other beyond margin; `tradeoff` = improves one, regresses the other — maintainer's
judgement; `reject` = no improvement beyond noise. It lands on your PR as a comment + commit
status. **Merging is the maintainer's decision.** On merge, your code becomes the new base
everyone else must beat, and `zk-arena-record` appends your row to the leaderboard.

## Why this design

- **Composability**: you build on the champion automatically — no vendoring the previous
  winner's patch.
- **Comparability**: the task, runners, toolchain, budgets and the soundness anchor never
  move; only the prover does. Paired same-VM grading makes every Δ hardware-honest.
- **Auditability**: the branch history is append-only (force-pushes disabled); every row links
  to a merged PR carrying its full grading verdict.
- **Upstreamability**: the branch is a reviewable sequence of optimization commits on top of
  upstream aztec-packages — transferring the work upstream is a PR away.

The previous patch-based arena (separate repo, submission dirs + `changes.patch`) is archived
at [lordshashank/zk-prover-arena](https://github.com/lordshashank/zk-prover-arena) — it
documents the grading rationale in depth ([RESEARCH.md](https://github.com/lordshashank/zk-prover-arena/blob/main/RESEARCH.md))
and remains the spec this flow inherits its gates and margins from.
