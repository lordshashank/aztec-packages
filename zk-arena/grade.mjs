// zk-prover-arena — grade a candidate PROVER (native bb build) on the pinned task.
//
// ALGORITHM TRACK. The circuit, proof system, and config are frozen. The ONLY
// variable is the prover implementation: a barretenberg `bb` binary, typically
// rebuilt from modified C++ (MSM, FFT/NTT, polynomial memory, ...).
//
// Metrics (separate boards, both lower-is-better):
//   time   = median wall-clock seconds of `bb prove`, SINGLE-THREADED
//   memory = peak resident set size (MiB) of the prove process
//
// ANTI-GAMING DESIGN (each gate closes a concrete exploit):
//   1. FRESH WITNESS PER RUN — a random input x is sampled, `nargo execute`
//      computes the witness and the expected public output, and the candidate's
//      emitted public_inputs MUST equal that output. A binary replaying a
//      cached/embedded proof cannot know the fresh output; forging a proof for
//      it without proving = breaking UltraHonk soundness.
//   2. SOUNDNESS — the PINNED BASELINE `bb verify` must accept the proof against
//      the PINNED VK (problem/baseline_vk/vk). The candidate never judges itself.
//   3. CROSS-BUDGETS — no trading one resource for rank on the other board:
//        time board   : valid only if peak RSS <= 4096 MiB (the wasm32 ceiling;
//                       keeps time entries browser-transferable)
//        memory board : valid only if median time <= 2x baseline
//   4. DISK GATE — block-output ops bounded (baseline: 0), closing the
//      mmap/spill loophole (file-backed pages hide from RSS — bb's own
//      --slow_low_memory would otherwise "win" the memory board for free).
//   5. SINGLE-THREAD — confirmed from bb's own log line.
//
// Usage:
//   node grade.mjs --stack=baseline
//   node grade.mjs --stack=my-msm-fix --bb=/abs/path/to/modified/bb
//   --json=<file>   also emit a machine-readable result {medianS, peakMiB, runs:[...], gates:{...}}
//   --boards=<dir>  append rows to <dir> instead of ./boards (promote.mjs isolates candidate runs)
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir, cpus, totalmem } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));

const runs = args.runs ? parseInt(args.runs) : 3;
const stackName = args.stack || 'baseline';
const BOARDS_DIR = args.boards ? resolve(args.boards) : resolve(__dirname, 'boards');
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'problem', 'manifest.json'), 'utf8'));
const BUDGET = manifest.validity.budgets;
const BASELINE_BB = process.env.BASELINE_BB || resolve(homedir(), '.bb-next', 'bb');
const NARGO = process.env.NARGO_BIN || resolve(homedir(), '.nargo', 'bin', 'nargo');
// Machine fingerprint: scores are only comparable within one environment, so every
// result records where it was measured. CI sets ZKARENA_MACHINE to the official label.
const MACHINE = process.env.ZKARENA_MACHINE
  || `${cpus()[0]?.model?.trim() || 'unknown-cpu'} | ${process.platform}-${process.arch} | ${Math.round(totalmem() / 2 ** 30)}GiB`;

let candidateBB = args.bb;
if (!candidateBB) {
  const reg = JSON.parse(readFileSync(resolve(__dirname, 'stacks', 'registry.json'), 'utf8'));
  const entry = reg.stacks[stackName];
  if (!entry) throw new Error(`unknown stack "${stackName}" — add it to stacks/registry.json or pass --bb=<path>`);
  candidateBB = entry.bb === 'BASELINE' ? BASELINE_BB : entry.bb;
}
if (!existsSync(candidateBB)) throw new Error(`bb binary not found: ${candidateBB}`);
if (!existsSync(BASELINE_BB)) throw new Error(`baseline bb not found at ${BASELINE_BB} (set BASELINE_BB env var)`);

const CIRCUIT = resolve(__dirname, manifest.circuit);
const SOURCE_PKG = resolve(__dirname, 'problem', 'source');
const PINNED_WITNESS = resolve(__dirname, manifest.witness);
const VK_DIR = resolve(__dirname, 'problem', 'baseline_vk');
const VK = resolve(VK_DIR, 'vk');
const ENV1 = { ...process.env, HARDWARE_CONCURRENCY: '1' };
const haveNargo = existsSync(NARGO) && existsSync(resolve(SOURCE_PKG, 'Nargo.toml'));

if (!existsSync(VK)) {
  console.log('  [setup] computing pinned baseline VK (one-time, baseline bb)...');
  mkdirSync(VK_DIR, { recursive: true });
  const r = spawnSync(BASELINE_BB, ['write_vk', '--scheme', 'ultra_honk', '-b', CIRCUIT, '-o', VK_DIR], { env: ENV1, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(VK)) throw new Error(`baseline write_vk failed: ${(r.stderr || '').slice(-300)}`);
}

// ---- Fresh witness: random x -> nargo execute -> { witnessPath, expectedHex } ----
function freshWitness(runDir) {
  const pkg = resolve(runDir, 'source');
  cpSync(SOURCE_PKG, pkg, { recursive: true });
  rmSync(resolve(pkg, 'target'), { recursive: true, force: true });
  const x = BigInt('0x' + randomBytes(31).toString('hex')).toString(10); // 248-bit < field modulus
  writeFileSync(resolve(pkg, 'Prover.toml'), `x = "${x}"\n`);
  const r = spawnSync(NARGO, ['execute', '--silence-warnings'], { cwd: pkg, encoding: 'utf8' });
  const m = /Circuit output:\s*(0x[0-9a-fA-F]+)/.exec((r.stdout || '') + (r.stderr || ''));
  const wit = resolve(pkg, 'target', 'synth.gz');
  if (r.status !== 0 || !m || !existsSync(wit)) throw new Error(`nargo execute failed: ${(r.stderr || '').slice(-300)}`);
  return { witnessPath: wit, expectedHex: m[1].slice(2).toLowerCase().padStart(64, '0') };
}

// ---- One graded run: fresh challenge, candidate proves, gates checked ----
function gradedRun(i) {
  const runDir = resolve(tmpdir(), `zkarena-${process.pid}-${i}`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  try {
    let witnessPath = PINNED_WITNESS, expectedHex = null, fresh = false;
    if (haveNargo) {
      ({ witnessPath, expectedHex } = freshWitness(runDir));
      fresh = true;
    }

    const outDir = resolve(runDir, 'out');
    mkdirSync(outDir);
    const isLinux = process.platform === 'linux';
    const t0 = process.hrtime.bigint();
    const p = spawnSync('/usr/bin/time',
      [isLinux ? '-v' : '-l', candidateBB, 'prove', '--scheme', 'ultra_honk', '-b', CIRCUIT, '-w', witnessPath, '-k', VK, '-o', outDir],
      { env: ENV1, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const proveS = Number(process.hrtime.bigint() - t0) / 1e9;
    if (p.status !== 0) return { ok: false, err: `prove exit ${p.status}: ${(p.stderr || '').slice(-300)}` };

    const errOut = p.stderr || '';
    let peakMiB = null;
    const mMac = /(\d+)\s+maximum resident set size/.exec(errOut);
    const mLin = /Maximum resident set size[^:]*:\s*(\d+)/.exec(errOut);
    if (mMac) peakMiB = parseInt(mMac[1]) / (1024 * 1024);
    else if (mLin) peakMiB = parseInt(mLin[1]) / 1024;

    let diskOps = null;
    const dMac = /(\d+)\s+block output operations/.exec(errOut);
    const dLin = /File system outputs:\s*(\d+)/.exec(errOut);
    if (dMac) diskOps = parseInt(dMac[1]); else if (dLin) diskOps = parseInt(dLin[1]);

    const threadLine = /num threads:\s*(\d+)/.exec((p.stdout || '') + errOut);
    const threadsUsed = threadLine ? parseInt(threadLine[1]) : null;

    // Gate: emitted public output must equal the fresh expected output.
    const pubPath = resolve(outDir, 'public_inputs');
    const proofPath = resolve(outDir, 'proof');
    let outputMatch = !fresh; // without nargo we cannot check (row gets noted)
    if (fresh && existsSync(pubPath)) {
      outputMatch = readFileSync(pubPath).toString('hex').toLowerCase() === expectedHex;
    }

    // Gate: pinned baseline verifier, pinned VK.
    let verified = false;
    if (existsSync(proofPath) && existsSync(pubPath)) {
      const v = spawnSync(BASELINE_BB, ['verify', '--scheme', 'ultra_honk', '-p', proofPath, '-k', VK, '-i', pubPath], { env: ENV1, encoding: 'utf8' });
      verified = v.status === 0;
    }
    return { ok: true, proveS, peakMiB, diskOps, verified, outputMatch, threadsUsed, fresh };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log(`\n=== zk-prover-arena :: grading "${stackName}" on task "${manifest.name}" (2^${Math.log2(manifest.paddedSize)}) ===`);
console.log(`candidate bb: ${candidateBB}`);
console.log(`machine: ${MACHINE}`);
console.log(`fresh witness per run: ${haveNargo ? 'yes (nargo)' : 'NO — pinned-witness fallback, output gate skipped'}`);
console.log(`budgets: time board needs peakRSS<=${BUDGET.timeBoardMemBudgetMiB}MiB; memory board needs time<=${BUDGET.memoryBoardTimeBudgetS}s; diskOps<=${BUDGET.maxBlockOutputOps}; runs=${runs}\n`);

const times = []; const peaks = []; const disks = []; const runDetails = [];
let allVerified = true, allOutputs = true, ok = true, lastErr = null, threadViolation = false, anyFresh = false;
for (let r = 0; r < runs; r++) {
  const res = gradedRun(r);
  if (!res.ok) { ok = false; lastErr = res.err; break; }
  runDetails.push({ proveS: res.proveS, peakMiB: res.peakMiB, diskOps: res.diskOps, verified: res.verified, outputMatch: res.outputMatch, threadsUsed: res.threadsUsed, fresh: res.fresh });
  if (res.threadsUsed != null && res.threadsUsed !== 1) threadViolation = true;
  times.push(res.proveS); peaks.push(res.peakMiB);
  if (res.diskOps != null) disks.push(res.diskOps);
  if (!res.verified) allVerified = false;
  if (!res.outputMatch) allOutputs = false;
  if (res.fresh) anyFresh = true;
  console.log(`  run ${r + 1}/${runs}: prove ${res.proveS.toFixed(2)}s  peakRSS ${res.peakMiB?.toFixed(0)}MiB  diskOps ${res.diskOps}  threads=${res.threadsUsed}  verified=${res.verified}  outputMatch=${res.outputMatch}`);
}

const medS = times.length ? +median(times).toFixed(2) : null;
const peakMiB = peaks.length ? Math.max(...peaks.filter((x) => x != null)) : null;
const maxDisk = disks.length ? Math.max(...disks) : null;
const diskOk = maxDisk == null || maxDisk <= BUDGET.maxBlockOutputOps;

const coreValid = ok && allVerified && allOutputs && !threadViolation && diskOk && medS != null && peakMiB != null;
const timeBoardValid = coreValid && peakMiB <= BUDGET.timeBoardMemBudgetMiB;
const memBoardValid = coreValid && medS <= BUDGET.memoryBoardTimeBudgetS;

console.log(`\n  median prove: ${medS ?? 'n/a'} s    peak RSS: ${peakMiB?.toFixed(0) ?? 'n/a'} MiB    max diskOps: ${maxDisk ?? 'n/a'}`);
console.log(`  gates: soundness=${allVerified ? 'PASS' : 'FAIL'}  freshOutput=${allOutputs ? (anyFresh ? 'PASS' : 'SKIPPED') : 'FAIL'}  single-thread=${threadViolation ? 'FAIL' : 'PASS'}  disk=${diskOk ? 'PASS' : 'FAIL'}  complete=${ok ? 'PASS' : 'FAIL'}`);
console.log(`  time board: ${timeBoardValid ? 'VALID' : 'INVALID'} (mem budget ${peakMiB != null ? peakMiB.toFixed(0) : '?'}<=${BUDGET.timeBoardMemBudgetMiB})   memory board: ${memBoardValid ? 'VALID' : 'INVALID'} (time budget ${medS ?? '?'}<=${BUDGET.memoryBoardTimeBudgetS})${ok ? '' : '  (' + String(lastErr).slice(0, 100) + ')'}\n`);

const iso = args.now || new Date().toISOString();
const note = [ok ? '' : 'ERR', anyFresh ? '' : 'pinned-witness', diskOk ? '' : 'disk-spill'].filter(Boolean).join(',');
function append(file, header, row) {
  const p = resolve(BOARDS_DIR, file);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) appendFileSync(p, header.join('\t') + '\n');
  appendFileSync(p, row.join('\t') + '\n');
}
append('time.tsv', ['iso', 'stack', 'task', 'median_prove_s', 'peak_rss_MiB', 'verified', 'valid', 'note', 'machine'],
  [iso, stackName, manifest.name, medS ?? '', peakMiB != null ? peakMiB.toFixed(0) : '', allVerified ? 1 : 0, timeBoardValid ? 1 : 0, note, MACHINE]);
append('memory.tsv', ['iso', 'stack', 'task', 'peak_rss_MiB', 'median_prove_s', 'verified', 'valid', 'note', 'machine'],
  [iso, stackName, manifest.name, peakMiB != null ? peakMiB.toFixed(0) : '', medS ?? '', allVerified ? 1 : 0, memBoardValid ? 1 : 0, note, MACHINE]);
console.log(`  appended to boards/ — \`node board.mjs --md\` refreshes LEADERBOARD.md\n`);

if (args.json) {
  writeFileSync(resolve(args.json), JSON.stringify({
    iso, task: manifest.name, stack: stackName, bb: candidateBB, machine: MACHINE, runsRequested: runs,
    medianS: medS, peakMiB: peakMiB != null ? +peakMiB.toFixed(0) : null, maxDiskOps: maxDisk,
    runs: runDetails,
    gates: { soundness: allVerified, freshOutput: allOutputs && anyFresh, singleThread: !threadViolation, disk: diskOk, complete: ok },
    timeBoardValid, memBoardValid, note, error: ok ? null : String(lastErr),
  }, null, 2) + '\n');
}
