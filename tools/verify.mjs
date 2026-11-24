// Pre-submission checks: two builds must be byte-identical, the board must satisfy the gate's shape,
// and dossier.json must equal what the vendored builder produces from the same output directory.
//
//   node tools/verify.mjs [--input path/to/snapshot.json]

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const inputArg = args.indexOf('--input') === -1 ? null : args[args.indexOf('--input') + 1];
const input = inputArg ?? join(repo, 'input/snapshot.json');

function fail(message) {
  console.error('FAIL ' + message);
  process.exitCode = 1;
}

async function buildInto(dir) {
  execFileSync(process.execPath, [join(repo, 'main.ts'), '--input', input], {
    cwd: repo,
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: dir },
    stdio: 'pipe',
  });
}

async function walk(dir, base = dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, acc);
    else acc.push(relative(base, full));
  }
  return acc.sort();
}

const a = await mkdtemp(join(tmpdir(), 'radar-a-'));
const b = await mkdtemp(join(tmpdir(), 'radar-b-'));
try {
  await buildInto(a);
  await buildInto(b);

  const filesA = await walk(a);
  const filesB = await walk(b);
  if (filesA.join('\n') !== filesB.join('\n')) fail('two runs wrote different file lists');
  for (const file of filesA) {
    const one = await readFile(join(a, file));
    const two = await readFile(join(b, file));
    if (!one.equals(two)) fail('not byte-identical: ' + file);
  }
  console.log('ok   double run: ' + filesA.length + ' files byte-identical');

  const board = JSON.parse(await readFile(join(a, 'board.json'), 'utf8'));
  const rows = board.rows;
  if (!Array.isArray(rows) || rows.length < 100 || rows.length > 4000) fail('rows out of range: ' + rows.length);
  let last = Infinity;
  rows.forEach((row, i) => {
    if (row.rank !== i + 1) fail('rank discontinuity at ' + (i + 1) + ': ' + row.rank);
    if (!(row.implied_value_usd > 0) || row.implied_value_usd > 1e14) fail('implied out of range: ' + row.slug);
    if (row.implied_value_usd > last) fail('implied rises at ' + row.slug);
    last = row.implied_value_usd;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) fail('farm steps count: ' + row.slug);
    for (const step of row.farm_steps) {
      if (typeof step !== 'string' || step.length < 20 || step.length > 600) fail('farm step length: ' + row.slug);
    }
    if (!(row.tvl_usd > 0) || !(row.peer_token_rate >= 0 && row.peer_token_rate <= 1)) fail('rates: ' + row.slug);
  });
  console.log('ok   board: ' + rows.length + ' rows, ranks 1..' + rows.length + ', implied non-rising, steps 3-12');

  const dossierBytes = await readFile(join(a, 'dossier.json'));
  const expected = await buildDossier(a, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
  const expectedBytes = expected && expected.buffer ? Buffer.from(expected.buffer, expected.byteOffset ?? 0, expected.byteLength) : Buffer.from(JSON.stringify(expected));
  if (!dossierBytes.equals(expectedBytes)) {
    console.error('FAIL dossier.json does not equal buildDossier(out)');
    console.error('     stopping: a mismatched dossier fails the gate');
    process.exit(1);
  }
  if (dossierBytes.length > 1.5 * 1024 * 1024) fail('dossier over 1.5 MiB');
  console.log('ok   dossier: equals buildDossier(out), ' + dossierBytes.length + ' bytes');

  const shots = await readdir(join(a, 'screenshots'));
  const pngs = shots.filter((s) => s.endsWith('.png') || s.endsWith('.jpg') || s.endsWith('.jpeg'));
  if (pngs.length < 3 || pngs.length > 4) fail('screenshot count: ' + pngs.length);
  for (const shot of pngs) {
    const info = await stat(join(a, 'screenshots', shot));
    if (info.size > 512 * 1024) fail('screenshot over 512 KiB: ' + shot);
  }
  console.log('ok   screenshots: ' + pngs.length + ' images, all under 512 KiB');
} finally {
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
}
