// zk-arena — record a merged submission on the leaderboard.
//
// The leaderboard of the rolling-champion model is a monotone changelog: one row per
// merged PR, carrying the official paired-grading numbers from the verdict that was
// posted on the PR before the maintainer merged it.
//
// Usage: node zk-arena/record.mjs --verdict=<verdict.json> --pr=<n> --title=<t> --author=<login> --model=<m> --merge=<sha>
// Appends a row to zk-arena/LEADERBOARD.md (above the ROWS-ABOVE marker) and an entry
// to zk-arena/log.jsonl. Idempotent per merge sha.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));

const verdict = JSON.parse(readFileSync(resolve(args.verdict), 'utf8'));
const mergeSha = args.merge || verdict.mergeSha || '';
const logPath = resolve(__dirname, 'log.jsonl');
if (existsSync(logPath) && readFileSync(logPath, 'utf8').includes(mergeSha.slice(0, 12))) {
  console.log(`merge ${mergeSha.slice(0, 12)} already recorded — skipping`);
  process.exit(0);
}

const arm = verdict.arm64 || {};
const x86 = verdict.x86 || {};
const fmt = (v, suffix = '') => (v == null ? 'n/a' : `${v}${suffix}`);
const row = [
  new Date().toISOString().slice(0, 10),
  `#${args.pr} ${String(args.title || '').replaceAll('|', '\\|').slice(0, 80)}`,
  `@${args.author || 'unknown'}`,
  String(args.model || 'unspecified').replaceAll('|', '\\|').slice(0, 48),
  fmt(arm.cand?.timeS, ' s'),
  arm.available ? `${arm.timeDeltaS > 0 ? '−' : '+'}${Math.abs(arm.timeDeltaS ?? 0)} s` : 'n/a',
  fmt(arm.cand?.peakMiB, ' MiB'),
  arm.available ? `${arm.memDeltaMiB > 0 ? '−' : '+'}${Math.abs(arm.memDeltaMiB ?? 0)} MiB` : 'n/a',
  x86.available ? fmt(x86.timeRatio) : 'n/a',
  verdict.status,
  `\`${mergeSha.slice(0, 10)}\``,
];

const lbPath = resolve(__dirname, 'LEADERBOARD.md');
const lb = readFileSync(lbPath, 'utf8');
const MARKER = '<!-- ROWS-ABOVE: record.mjs inserts new rows directly above this line -->';
if (!lb.includes(MARKER)) throw new Error('LEADERBOARD.md marker not found');
writeFileSync(lbPath, lb.replace(MARKER, `| ${row.join(' | ')} |\n${MARKER}`));

appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), pr: args.pr, title: args.title || '', author: args.author, model: args.model || 'unspecified', mergeSha, verdict }) + '\n');
console.log(`recorded PR #${args.pr} (${mergeSha.slice(0, 10)}) on the leaderboard`);
