import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CsvBatchError, normalizeGlossary } from './csv-batch.mjs';

export function mergeGlossaries(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const entry of list ?? []) merged.set(entry.source, entry);
  }
  return Array.from(merged.values());
}

export function createGlossaryStore(file) {
  async function load() {
    try {
      const raw = await readFile(file, 'utf8');
      return normalizeGlossary(JSON.parse(raw));
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      if (err instanceof SyntaxError) throw new CsvBatchError(`术语表不是合法 JSON：${file}`);
      throw err;
    }
  }

  async function save(entries) {
    const normalized = normalizeGlossary(entries);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(temp, file);
    return normalized;
  }

  return { file, load, save };
}
