// Radar-2 entry program: snapshot in, ranked board and dashboard out (Node 22, stdlib only).
//
// Given the sealed snapshot, this program scores every rankable pre-token protocol, writes
// the board to board.json, the dashboard's dataset to data.js, mirrors dashboard/ and
// screenshots/ into the output directory, and finishes with dossier.json from the vendored
// make.fun library. The gate rebuilds that dossier from the same output and compares bytes,
// so the program rebuilds it too and refuses to finish on a mismatch.
//
// Run it outside the grader's container like this:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// Inside the container the snapshot is mounted at /input and the output goes to /output.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** Caps the scorer enforces: the dossier text cap, the screenshot caps, the dashboard caps. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASH_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--flag value` and `--flag=value` pairs out of argv into a plain object. */
function readFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
      flags[token.slice(2)] = argv[++i]!;
    }
  }
  return flags;
}

const flags = readFlags(process.argv.slice(2));
const root = fileURLToPath(new URL('.', import.meta.url));

/** The snapshot's path: --input names a file or a directory holding snapshot.json. */
function snapshotPath(): string {
  const given = flags['input'] ?? '/input';
  const direct = given.endsWith('.json') ? given : join(given, 'snapshot.json');
  if (!existsSync(direct)) {
    process.stderr.write(`radar-2: no snapshot at ${direct} (pass --input <snapshot.json|directory> or mount /input)\n`);
    process.exit(2);
  }
  return direct;
}

/** The output directory: --output, else MAKEFUN_OUTPUT_DIR, else /output. */
const outDir = resolve(flags['output'] ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath(), 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) {
  process.stderr.write(`radar-2: the board fails the gate: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/** Write text to a file under the output directory, creating parents as needed. */
function emitText(rel: string, text: string): void {
  const target = join(outDir, rel);
  mkdirSync(join(outDir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
  writeFileSync(target, text);
}

emitText('board.json', `${JSON.stringify({ rows: board })}\n`);
emitText('data.js', dataScript(radar));

/** Mirror a directory's files into the output, skipping dot-names, and report what landed. */
function mirrorDir(rel: string): string[] {
  const from = join(root, rel);
  const to = join(outDir, rel);
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const landed: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const src = join(dir, name);
      const relName = prefix ? `${prefix}/${name}` : name;
      if (statSync(src).isDirectory()) {
        mkdirSync(join(to, relName), { recursive: true });
        walk(src, relName);
      } else if (statSync(src).isFile()) {
        copyFileSync(src, join(to, relName));
        landed.push(relName);
      }
    }
  };
  walk(from, '');
  return landed;
}

const pageFiles = mirrorDir('dashboard');
if (!pageFiles.includes('index.html')) {
  process.stderr.write('radar-2: dashboard/ has no index.html to serve\n');
  process.exit(1);
}

const shots = mirrorDir('screenshots');
if (shots.length < 3) {
  process.stderr.write(`radar-2: screenshots/ holds ${shots.length} image(s); hand in 3: the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) {
    process.stderr.write(`radar-2: screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

const dossierOpts = { text_max_bytes: DOSSIER_TEXT_CAP, screenshots: SHOT_LIMITS, dashboard: DASH_LIMITS };
const dossierBytes = Buffer.from(buildDossier(outDir, dossierOpts));
writeFileSync(join(outDir, 'dossier.json'), dossierBytes);
if (!Buffer.from(buildDossier(outDir, dossierOpts)).equals(dossierBytes)) {
  process.stderr.write('radar-2: dossier.json does not round-trip through buildDossier\n');
  process.exit(1);
}

process.stdout.write(
  `radar-2: scored ${board.length} rows from ${snapshot.protocols.length} protocols (${snapshot.watchlist.length} watchlist, ${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `radar-2: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images) and dossier.json into ${outDir}\n`,
);
