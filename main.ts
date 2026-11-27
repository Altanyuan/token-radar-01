// Token Radar's entry program: sealed snapshot in, ranked board and dashboard out.
//
// Node 22, standard library only. It scores the snapshot with the radar model, writes
// board.json and the dashboard's data.js, copies dashboard/ and screenshots/ into the
// output directory, and finishes with dossier.json from the vendored make.fun library.
// The gate rebuilds that dossier from the same output and compares bytes, so this program
// rebuilds it too and refuses to finish on a mismatch.
//
// Run it outside the grader's container like this:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// Inside the container the snapshot is mounted at /input and the output goes to /output.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, parseSnapshot, toDataScript, validateBoard } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** The caps the gate enforces on the dossier text, the screenshots and the dashboard. */
const TEXT_CAP = 65_536;
const SHOT_CAP = { max: 4, max_bytes: 524_288 };
const PAGE_CAP = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const here = fileURLToPath(new URL('.', import.meta.url));

/** Pull `--name value` and `--name=value` pairs out of argv. */
function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    i += 1;
    if (!token.startsWith('--')) continue;
    const cut = token.indexOf('=');
    if (cut >= 0) {
      out.set(token.slice(2, cut), token.slice(cut + 1));
      continue;
    }
    const name = token.slice(2);
    if (i < argv.length && !argv[i]!.startsWith('--')) {
      out.set(name, argv[i]!);
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** Where the snapshot lives: --input names a file, or a directory holding snapshot.json. */
function locateSnapshot(): string {
  const given = args.get('input') ?? '/input';
  const path = given.endsWith('.json') ? given : join(given, 'snapshot.json');
  if (!existsSync(path)) {
    process.stderr.write(`radar: no snapshot at ${path} (pass --input <snapshot.json|directory> or mount /input)\n`);
    process.exit(2);
  }
  return path;
}

/** Where the output goes: --output, else MAKEFUN_OUTPUT_DIR, else /output. */
const outDir = resolve(args.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(locateSnapshot(), 'utf8'));
const { board, radar } = assemble(snapshot);
const fault = validateBoard(board, snapshot);
if (fault !== null) {
  process.stderr.write(`radar: the board fails the gate: ${fault}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

/** Write text under the output directory, making the parent directories first. */
function putText(rel: string, text: string): void {
  const parts = rel.split('/').slice(0, -1);
  if (parts.length > 0) mkdirSync(join(outDir, ...parts), { recursive: true });
  writeFileSync(join(outDir, rel), text);
}

putText('board.json', `${JSON.stringify({ rows: board })}\n`);
putText('data.js', toDataScript(radar));

/**
 * Copy a directory tree into the output, skipping dot-names, and return the relative
 * paths that landed. Walks with an explicit stack instead of recursion.
 */
function copyTree(rel: string): string[] {
  const from = join(here, rel);
  const to = join(outDir, rel);
  if (!existsSync(from)) return [];
  const landed: string[] = [];
  const stack: Array<[string, string]> = [[from, '']];
  while (stack.length > 0) {
    const [dir, prefix] = stack.pop()!;
    mkdirSync(join(to, prefix), { recursive: true });
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const src = join(dir, name);
      const relName = prefix ? `${prefix}/${name}` : name;
      if (statSync(src).isDirectory()) {
        stack.push([src, relName]);
      } else if (statSync(src).isFile()) {
        copyFileSync(src, join(to, relName));
        landed.push(relName);
      }
    }
  }
  return landed.sort();
}

const pageFiles = copyTree('dashboard');
if (!pageFiles.includes('index.html')) {
  process.stderr.write('radar: dashboard/ has no index.html to serve\n');
  process.exit(1);
}

const shots = copyTree('screenshots');
if (shots.length < 3) {
  process.stderr.write(`radar: screenshots/ holds ${shots.length} image(s); hand in 3: the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) {
    process.stderr.write(`radar: screenshots/${name}: names are letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

const caps = { text_max_bytes: TEXT_CAP, screenshots: SHOT_CAP, dashboard: PAGE_CAP };
const dossier = Buffer.from(buildDossier(outDir, caps));
writeFileSync(join(outDir, 'dossier.json'), dossier);
if (!Buffer.from(buildDossier(outDir, caps)).equals(dossier)) {
  process.stderr.write('radar: dossier.json does not round-trip through buildDossier\n');
  process.exit(1);
}

process.stdout.write(
  `radar: scored ${board.length} rows from ${snapshot.protocols.length} protocols (${snapshot.watchlist.length} watchlist, ${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images) and dossier.json into ${outDir}\n`,
);
