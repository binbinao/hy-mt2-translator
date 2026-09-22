/**
 * Emits the static build that GitHub Pages serves.
 *
 *   node build-pages.mjs   →  ../docs
 *
 * `public/` is already dependency-free (plain ES modules, no bundler), so the
 * "build" is a copy plus a `.nojekyll` marker. Keeping it a script instead of
 * a hand-maintained `docs/` folder means the published site can never drift
 * from the sources.
 */
import { cp, mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'public');
const DEST = path.resolve(HERE, '..', 'docs');

async function walk(dir, base = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });
await cp(SRC, DEST, { recursive: true });
// Without this, GitHub Pages runs Jekyll and drops files whose names start
// with an underscore.
await writeFile(path.join(DEST, '.nojekyll'), '');

const files = await walk(DEST);
let bytes = 0;
for (const f of files) bytes += (await stat(path.join(DEST, f))).size;

process.stdout.write(
  `Pages build → ${path.relative(process.cwd(), DEST)}/\n`
  + files.sort().map((f) => `  ${f}\n`).join('')
  + `  ${files.length} files, ${(bytes / 1024).toFixed(1)} KB\n`,
);
