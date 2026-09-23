/**
 * Hy-MT2 译稿台 — local translation frontend.
 *
 *   GET  /                 the desk
 *   GET  /api/config       limit + languages + model status
 *   GET  /api/status       model status only (polled while starting)
 *   POST /api/model/start  ensure the model server is up
 *   POST /api/translate    validate, then stream the translation as SSE
 *
 * Zero dependencies: node:http only, Node >= 20.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MAX_CHARS, measure, rejection } from './public/limit.mjs';
import { LANGUAGES, DEFAULT_TARGET, findLanguage } from './public/languages.mjs';
import { createModelManager } from './lib/model.mjs';
import { buildPrompt, streamTranslation } from './public/translate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const REPO_ROOT = path.resolve(HERE, '..');

const NUM = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const MODEL_ORIGIN = process.env.MODEL_ORIGIN ?? 'http://127.0.0.1:8080';
const PORT = NUM(process.env.PORT, 8787);
const MODEL_FILE = process.env.MODEL_PATH
  ?? path.join(REPO_ROOT, process.env.MODEL_NAME ?? 'Hy-MT2-1.8B-Q4_K_M.gguf');

const model = createModelManager({
  origin: MODEL_ORIGIN,
  bin: process.env.LLAMA_SERVER ?? 'llama-server',
  modelPath: MODEL_FILE,
  ctx: NUM(process.env.CTX, 8192),
  gpuLayers: NUM(process.env.NGL, 0),
  threads: process.env.THREADS ? NUM(process.env.THREADS, null) : null,
  autoStart: process.env.AUTO_START !== '0',
  startTimeoutMs: NUM(process.env.MODEL_TIMEOUT_MS, 180_000),
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

async function handleTranslate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.message });
  }

  const text = typeof body.text === 'string' ? body.text : '';
  const mode = body.mode === 'markdown' ? 'markdown' : 'plain';
  const lang = findLanguage(body.target ?? DEFAULT_TARGET);
  if (!lang) {
    return sendJson(res, 400, { error: '不支持的目标语言' });
  }

  const report = measure(text, MAX_CHARS);
  if (report.over || report.empty) {
    return sendJson(res, report.over ? 413 : 400, { error: rejection(report), report });
  }

  try {
    await model.ensure();
  } catch (err) {
    return sendJson(res, 503, { error: String(err.message ?? err), model: model.status() });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const started = Date.now();
  let firstByteAt = null;
  try {
    event('start', { target: lang.code, mode, chars: report.chars, han: report.han });
    const { chars } = await streamTranslation({
      url: `${MODEL_ORIGIN}/v1/chat/completions`,
      prompt: buildPrompt({ text, lang, mode }),
      headers: model.authHeaders(),
      signal: controller.signal,
      onDelta: (delta) => {
        firstByteAt ??= Date.now();
        event('delta', { text: delta });
      },
    });
    event('done', {
      chars,
      ms: Date.now() - started,
      ttft: firstByteAt ? firstByteAt - started : null,
    });
  } catch (err) {
    if (!controller.signal.aborted) event('error', { message: String(err.message ?? err) });
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (pathname === '/api/config') {
      return sendJson(res, 200, {
        maxChars: MAX_CHARS,
        defaultTarget: DEFAULT_TARGET,
        languages: LANGUAGES,
        model: model.status(),
      });
    }
    if (pathname === '/api/status') {
      return sendJson(res, 200, { model: model.status() });
    }
    if (pathname === '/api/model/start') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        await model.ensure();
        return sendJson(res, 200, { model: model.status() });
      } catch (err) {
        return sendJson(res, 503, { error: String(err.message ?? err), model: model.status() });
      }
    }
    if (pathname === '/api/translate') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      return await handleTranslate(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return await serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err.message ?? err) });
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await model.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
  if (signal) process.stderr.write(`\n收到 ${signal}，已退出。\n`);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('exit', () => {
  model.stop();
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `译稿台已就绪  http://127.0.0.1:${PORT}\n`
    + `  模型文件  ${MODEL_FILE}\n`
    + `  模型服务  ${MODEL_ORIGIN}${process.env.AUTO_START === '0' ? '（不自动启动）' : '（按需自动启动）'}\n`
    + `  长度上限  ${MAX_CHARS} 字符\n`,
  );
  model.ensure().catch((err) => {
    process.stderr.write(`模型预启动失败（首次翻译时会重试）：${err.message}\n`);
  });
});
