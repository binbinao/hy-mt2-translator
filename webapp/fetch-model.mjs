#!/usr/bin/env node
/**
 * Downloads the Hy-MT2-1.8B GGUF weights this desk runs on.
 *
 * The repository ships code, not weights (they are ~3.9 GB, over GitHub's free
 * LFS allowance), so a fresh clone has no model file and `npm start` has
 * nothing to load. This script fetches one straight from the HuggingFace repo
 * into the repository root, where the server looks for it.
 *
 *   node fetch-model.mjs                     # Q4_K_M (1.1 GB) → ../Hy-MT2-1.8B-Q4_K_M.gguf
 *   node fetch-model.mjs --model Q6_K        # or Q8_0, or `all`
 *   node fetch-model.mjs --list              # what is available, with sizes
 *   node fetch-model.mjs --endpoint https://hf-mirror.com
 *   node fetch-model.mjs --out /data/models
 *
 * Downloads resume: an interrupted run leaves `<name>.part` and the next run
 * continues from there with an HTTP Range request. Sizes and (when the endpoint
 * exposes them) LFS sha256 hashes are verified, so a truncated file left behind
 * by some other tool is detected and re-fetched rather than loaded.
 *
 * Zero dependencies — Node >= 20.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = 'tencent/Hy-MT2-1.8B-GGUF';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(HERE, '..');
const DEFAULT_ENDPOINT = 'https://huggingface.co';
const FALLBACK_ENDPOINT = 'https://hf-mirror.com'; // reachable where huggingface.co is not
const MODELS = ['Q4_K_M', 'Q6_K', 'Q8_0'];
const STALL_MS = 90_000;

/* ------------------------------------------------------------------- args */

function usage() {
  return `Hy-MT2-1.8B GGUF downloader

Usage: node fetch-model.mjs [options]

  --model <name>     ${MODELS.join(' | ')} | all            (default: Q4_K_M)
  --file <name>      any file in ${REPO} (e.g. imgs/logo-en.png)
  --out <dir>        where to save                       (default: ${DEFAULT_OUT})
  --endpoint <url>   HuggingFace-compatible endpoint      (default: $HF_ENDPOINT or
                                                          ${DEFAULT_ENDPOINT})
  --list             list available files and exit
  --verify           hash even files that already look complete
  --force            download again even when the file is complete
  --quiet            only print the outcome
  -h, --help         this text
`;
}

function parseArgs(argv) {
  const opts = {
    model: 'Q4_K_M', file: null, out: DEFAULT_OUT,
    endpoint: process.env.HF_ENDPOINT || DEFAULT_ENDPOINT,
    explicitEndpoint: Boolean(process.env.HF_ENDPOINT),
    list: false, verify: false, force: false, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--model': opts.model = take(); break;
      case '--file': opts.file = take(); break;
      case '--out': opts.out = path.resolve(take()); break;
      case '--endpoint': opts.endpoint = take().replace(/\/+$/, ''); opts.explicitEndpoint = true; break;
      case '--list': opts.list = true; break;
      case '--verify': opts.verify = true; break;
      case '--force': opts.force = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

/* --------------------------------------------------------------- helpers */

const human = (bytes) => {
  if (bytes === null || bytes === undefined) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u += 1; }
  return `${n.toFixed(n >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
};

const say = (quiet, ...args) => { if (!quiet) process.stdout.write(`${args.join(' ')}\n`); };

/* ------------------------------------------------------------- endpoint */

async function fetchJson(url, timeoutMs = 30_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** File list (name, size, lfs sha256) from the HF API, or null if unavailable. */
async function apiFileList(endpoint, timeoutMs = 5000) {
  try {
    const data = await fetchJson(`${endpoint}/api/models/${REPO}?blobs=true`, timeoutMs);
    const files = new Map();
    for (const sibling of data.siblings ?? []) {
      files.set(sibling.rfilename, {
        name: sibling.rfilename,
        size: sibling.size ?? sibling.lfs?.size ?? null,
        sha256: sibling.lfs?.sha256 ?? null,
      });
    }
    return files;
  } catch {
    return null; // unreachable, or a mirror that does not proxy the API
  }
}

/** Size (and sha256 if known) for one file, without downloading it. */
async function probeRemote(endpoint, file, apiFiles) {
  const known = apiFiles?.get(file);
  if (known?.size) return known;
  const url = `${endpoint}/${REPO}/resolve/main/${encodeURI(file)}`;
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const length = Number(head.headers.get('content-length'));
  if (head.ok && Number.isFinite(length) && length > 0) return { name: file, size: length, sha256: null };
  // Some CDNs reject HEAD; a one-byte range still reveals the total.
  const ranged = await fetch(url, { headers: { range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const total = /\/(\d+)$/.exec(ranged.headers.get('content-range') ?? '')?.[1];
  if (!ranged.ok || !total) throw new Error(`无法确定 ${file} 的大小（HTTP ${ranged.status}）`);
  return { name: file, size: Number(total), sha256: null };
}

/**
 * Picks the endpoint to use. The API call doubles as the reachability probe, so
 * an unreachable primary costs one short timeout instead of a separate 8s wait.
 */
async function resolveEndpoint(opts) {
  const files = await apiFileList(opts.endpoint);
  if (files) return { endpoint: opts.endpoint, files };
  if (opts.explicitEndpoint || opts.endpoint === FALLBACK_ENDPOINT) {
    return { endpoint: opts.endpoint, files: null }; // let the download itself report failure
  }
  say(opts.quiet, `⚠ ${opts.endpoint} 无响应，改用镜像 ${FALLBACK_ENDPOINT}`);
  return { endpoint: FALLBACK_ENDPOINT, files: await apiFileList(FALLBACK_ENDPOINT) };
}

/* -------------------------------------------------------------- download */

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function progressPrinter(total, quiet, startOffset = 0) {
  if (quiet) return () => {};
  const tty = process.stdout.isTTY;
  const startedAt = Date.now();
  let nextMark = 10; // first non-TTY line at 10%, so we never print a meaningless 0.0%
  return (received) => {
    const pct = total ? (received / total) * 100 : 0;
    const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    // Rate and ETA describe this run, not the bytes inherited from a resume.
    const rate = Math.max(0, received - startOffset) / seconds;
    const eta = total && rate > 0 ? ` ETA ${Math.round((total - received) / rate)}s` : '';
    const line = `  ${pct.toFixed(1)}%  ${human(received)}/${human(total)}  ${human(rate)}/s${eta}`;
    if (tty) {
      process.stdout.write(`\r${line}   `);
      return;
    }
    if (pct >= nextMark) { // non-TTY: roughly ten lines per download
      process.stdout.write(`${line}\n`);
      nextMark = Math.floor(pct / 10) * 10 + 10;
    }
  };
}

async function download({ endpoint, file, size, outDir, quiet }) {
  const url = `${endpoint}/${REPO}/resolve/main/${encodeURI(file)}`;
  const finalPath = path.join(outDir, path.basename(file));
  const partPath = `${finalPath}.part`;

  let offset = 0;
  try {
    const part = await stat(partPath);
    offset = part.size;
    if (size && offset >= size) {
      await rm(partPath, { force: true });
      offset = 0;
    }
  } catch { /* no partial file */ }

  if (offset > 0) say(quiet, `↻ 续传 ${path.basename(file)}（已有 ${human(offset)}）`);
  else say(quiet, `↓ 下载 ${path.basename(file)}  ${human(size)}`);

  const headers = {};
  if (offset > 0) headers.range = `bytes=${offset}-`;

  const controller = new AbortController();
  let lastChunkAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastChunkAt > STALL_MS) controller.abort(new Error('传输停滞超过 90 秒'));
  }, 5000);

  let received = offset;
  const report = progressPrinter(size, quiet, offset);
  const out = createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' });

  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    // A 200 means the server ignored our Range header: start over rather than corrupt.
    if (offset > 0 && res.status === 200) {
      offset = 0;
      received = 0;
      await rm(partPath, { force: true });
      out.destroy();
      return await download({ endpoint, file, size, outDir, quiet });
    }

    await pipeline(
      Readable.fromWeb(res.body),
      new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          lastChunkAt = Date.now();
          report(received);
          cb(null, chunk);
        },
      }),
      out,
    );
  } finally {
    clearInterval(watchdog);
  }

  const written = (await stat(partPath)).size;
  if (size && written !== size) {
    throw new Error(`大小不符：收到 ${human(written)}，应为 ${human(size)}（已保留 ${path.basename(partPath)}，重跑可续传）`);
  }
  await rename(partPath, finalPath);
  if (process.stdout.isTTY && !quiet) process.stdout.write('\n');
  return { finalPath, bytes: written };
}

/* ------------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(usage()); return; }

  const { endpoint, files: apiFiles } = await resolveEndpoint(opts);

  if (opts.list) {
    if (!apiFiles) throw new Error(`${endpoint} 不提供文件列表 API`);
    process.stdout.write(`${REPO} @ ${endpoint}\n`);
    for (const f of [...apiFiles.values()].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))) {
      const tag = MODELS.some((m) => f.name.includes(m)) ? '模型 ' : '     ';
      process.stdout.write(`  ${tag} ${human(f.size).padStart(8)}  ${f.name}\n`);
    }
    return;
  }

  const wanted = [];
  if (opts.file) {
    wanted.push(opts.file);
  } else if (opts.model.toLowerCase() === 'all') {
    wanted.push(...MODELS.map((m) => `Hy-MT2-1.8B-${m}.gguf`));
  } else {
    const needle = opts.model.toUpperCase();
    const key = MODELS.find((m) => m === needle) ?? MODELS.find((m) => m.includes(needle));
    if (!key) throw new Error(`未知模型「${opts.model}」，可选：${MODELS.join(' / ')} 或 all`);
    wanted.push(`Hy-MT2-1.8B-${key}.gguf`);
  }

  await mkdir(opts.out, { recursive: true });
  say(opts.quiet, `源： ${endpoint}/${REPO}`);
  say(opts.quiet, `目标：${opts.out}\n`);

  const results = [];
  for (const file of wanted) {
    const remote = await probeRemote(endpoint, file, apiFiles);
    const finalPath = path.join(opts.out, path.basename(file));

    let local = null;
    try { local = await stat(finalPath); } catch { /* absent */ }

    if (local && !opts.force) {
      if (remote.size && local.size !== remote.size) {
        say(opts.quiet, `⚠ ${path.basename(file)} 本地 ${human(local.size)}，远端 ${human(remote.size)}——不完整，重新下载`);
      } else if (opts.verify && remote.sha256) {
        say(opts.quiet, `· 校验 ${path.basename(file)} …`);
        const digest = await sha256File(finalPath);
        if (digest === remote.sha256) {
          say(opts.quiet, `✓ ${path.basename(file)} 已存在且校验通过（${human(local.size)}）`);
          results.push({ file, path: finalPath, skipped: true });
          continue;
        }
        say(opts.quiet, `⚠ ${path.basename(file)} sha256 不匹配，重新下载`);
      } else {
        say(opts.quiet, `✓ ${path.basename(file)} 已存在（${human(local.size)}），跳过。用 --verify 校验、--force 重下`);
        results.push({ file, path: finalPath, skipped: true });
        continue;
      }
    }

    const { finalPath: saved, bytes } = await download({
      endpoint, file, size: remote.size, outDir: opts.out, quiet: opts.quiet,
    });

    if (remote.sha256) {
      say(opts.quiet, '· 校验 sha256 …');
      const digest = await sha256File(saved);
      if (digest !== remote.sha256) {
        await rm(saved, { force: true });
        throw new Error(`${path.basename(file)} sha256 校验失败，已删除，请重试`);
      }
      say(opts.quiet, '✓ sha256 校验通过');
    }
    results.push({ file, path: saved, bytes });
  }

  say(opts.quiet, '');
  for (const r of results) {
    say(opts.quiet, r.skipped ? `= ${r.path}` : `✓ ${r.path}  ${human(r.bytes)}`);
  }
  say(opts.quiet, '\n下一步：cd webapp && npm start');
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${err?.message ?? err}\n`);
  process.exit(1);
});
