// zk-arena — combine the per-architecture paired gradings into an ADVISORY verdict.
//
// The rolling-champion model: every PR is graded against the branch tip it would
// merge into, paired on the same VM for both architectures. Because the lineage is a
// single branch, acceptance is PARETO, not single-axis: a PR should improve at least
// one metric beyond its noise margin and must not regress the other beyond the same
// margin — otherwise time-optimizers would trade away memory and vice versa.
//
// The verdict is ADVISORY: the maintainer decides whether to merge. This script just
// makes the numbers, margins and gates impossible to misread.
//
// Margins (same calibration as the original arena):
//   arm64 time   : improvement > max(0.5 s, 2σ)        (homogeneous Cobalt fleet)
//   x86 time     : ratio below 1 by > max(1.5%, 2σ_r)  (mixed fleet → ratio scoring)
//   memory       : > 75 MiB, either architecture
// Hard budgets (vs the ORIGINAL frozen baseline, enforced inside grade.mjs from
// problem/manifest.json): peak RSS <= 4096 MiB, median time <= 2x original baseline.
//
// Usage: node zk-arena/decide.mjs --arm64-dir=ci-in/arm64-grade --x86-dir=ci-in/x86-grade
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));

const loadJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const sigma = (runs) => {
  const xs = (runs || []).map((r) => r.proveS).filter((x) => x != null);
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
// All gates must hold — including freshOutput: the canonical runners always have nargo,
// so a missing fresh-witness check means the environment is broken, not optional.
const gatesPass = (g) => g && g.gates && Object.values(g.gates).every((v) => v === true);

function judgeArch(name, base, cand) {
  if (!base || !cand) return { arch: name, available: false };
  const sb = sigma(base.runs);
  const sc = sigma(cand.runs);
  const out = {
    arch: name, available: true, machine: cand.machine,
    base: { timeS: base.medianS, peakMiB: base.peakMiB },
    cand: { timeS: cand.medianS, peakMiB: cand.peakMiB },
    gates: cand.gates, timeBoardValid: cand.timeBoardValid, memBoardValid: cand.memBoardValid,
  };
  if (name === 'arm64') {
    const margin = Math.max(0.5, 2 * Math.sqrt(sb * sb + sc * sc));
    out.timeMarginS = +margin.toFixed(3);
    out.timeDeltaS = +(base.medianS - cand.medianS).toFixed(2);
    out.timeWin = out.timeDeltaS > margin;
    out.timeRegress = out.timeDeltaS < -margin;
  } else {
    const ratio = cand.medianS / base.medianS;
    const sr = ratio * Math.sqrt((sb / base.medianS) ** 2 + (sc / cand.medianS) ** 2);
    const margin = Math.max(0.015, 2 * sr);
    out.timeRatio = +ratio.toFixed(4);
    out.timeMarginRatio = +margin.toFixed(4);
    out.timeWin = ratio < 1 - margin;
    out.timeRegress = ratio > 1 + margin;
  }
  const memMargin = 75;
  out.memDeltaMiB = +(base.peakMiB - cand.peakMiB).toFixed(0);
  out.memWin = out.memDeltaMiB > memMargin;
  out.memRegress = out.memDeltaMiB < -memMargin;
  out.gatesPass = gatesPass(cand);
  return out;
}

const arm = judgeArch('arm64', loadJson(resolve(args['arm64-dir'] || 'ci-in/arm64-grade', 'base.json')),
                                loadJson(resolve(args['arm64-dir'] || 'ci-in/arm64-grade', 'cand.json')));
const x86 = judgeArch('x86', loadJson(resolve(args['x86-dir'] || 'ci-in/x86-grade', 'base.json')),
                              loadJson(resolve(args['x86-dir'] || 'ci-in/x86-grade', 'cand.json')));
const meta = loadJson(resolve(args['arm64-dir'] || 'ci-in/arm64-grade', 'meta.json'))
          || loadJson(resolve(args['x86-dir'] || 'ci-in/x86-grade', 'meta.json')) || {};

const arches = [arm, x86].filter((a) => a.available);
const anyWin = arches.some((a) => a.timeWin || a.memWin);
const anyRegress = arches.some((a) => a.timeRegress || a.memRegress);
const allGates = arches.length > 0 && arches.every((a) => a.gatesPass && a.timeBoardValid && a.memBoardValid);

let recommendation = 'reject';
let reason = 'no board improved beyond its noise margin';
if (!allGates) { recommendation = 'invalid'; reason = 'validity gates or hard budgets failed'; }
else if (anyWin && !anyRegress) { recommendation = 'accept'; reason = 'improves at least one metric beyond margin, no metric regresses beyond margin (Pareto)'; }
else if (anyWin && anyRegress) { recommendation = 'tradeoff'; reason = 'improves one metric but regresses another beyond margin — maintainer judgement required'; }

console.log(JSON.stringify({
  status: recommendation, reason,
  pr: meta.pr ?? null, baseSha: meta.baseSha ?? null, headSha: meta.headSha ?? null, mergeSha: meta.mergeSha ?? null,
  ts: new Date().toISOString(),
  arm64: arm, x86,
  note: 'advisory — merging is at the maintainer\'s discretion; on merge the candidate becomes the new base',
}, null, 2));
process.exit(0);
