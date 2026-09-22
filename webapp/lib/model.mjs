/**
 * Owns the llama-server process that backs this frontend.
 *
 * Policy: if something already answers on the model port we adopt it and
 * never touch that process. Otherwise we spawn llama-server ourselves and
 * tear it down on exit — we only ever kill what we started.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const LOG_TAIL = 40;

export function createModelManager({
  origin,
  bin = 'llama-server',
  modelPath,
  ctx = 8192,
  gpuLayers = 0,
  threads = null,
  autoStart = true,
  startTimeoutMs = 180_000,
}) {
  let state = 'idle'; // idle | starting | ready | external | error
  let detail = null;
  let child = null;
  let pending = null;
  let apiKey = null; // only set for the server we spawn
  const tail = [];

  function remember(line) {
    for (const part of String(line).split('\n')) {
      if (!part.trim()) continue;
      tail.push(part.trimEnd());
      if (tail.length > LOG_TAIL) tail.shift();
    }
  }

  async function probe(timeoutMs = 1500, authenticated = false) {
    try {
      const res = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: authenticated && apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function args() {
    const a = ['-m', modelPath, '--host', new URL(origin).hostname, '--port', new URL(origin).port,
      '-c', String(ctx), '-ngl', String(gpuLayers), '--no-webui', '-a', 'hy-mt2',
      '--api-key', apiKey];
    if (threads) a.push('-t', String(threads));
    return a;
  }

  async function launch() {
    if (!existsSync(modelPath)) {
      state = 'error';
      detail = `未找到模型文件：${modelPath}\n请设置 MODEL_PATH 环境变量，或把 .gguf 放在仓库根目录。`;
      throw new Error(detail);
    }
    state = 'starting';
    detail = `正在启动 llama-server（${modelPath.split('/').pop()}，-c ${ctx} -ngl ${gpuLayers}）…`;
    apiKey = randomUUID();

    child = spawn(bin, args(), { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on('data', (d) => remember(d));
    child.stderr.on('data', (d) => remember(d));

    const spawnFailed = new Promise((_, reject) => {
      child.once('error', (err) => {
        state = 'error';
        detail = err.code === 'ENOENT'
          ? `未找到可执行文件 ${bin}。请安装 llama.cpp（例如 brew install llama.cpp），或用 LLAMA_SERVER 指定路径。`
          : `启动 ${bin} 失败：${err.message}`;
        reject(new Error(detail));
      });
    });

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        spawnFailed.then(() => null),
        exited.then(() => 'exited'),
        delay(400).then(() => 'tick'),
      ]).catch((err) => {
        throw err;
      });
      if (outcome === 'exited') {
        const { code, signal } = await exited;
        state = 'error';
        detail = `llama-server 提前退出（code ${code}${signal ? `, ${signal}` : ''}）。`;
        throw new Error(`${detail}\n${tail.join('\n')}`);
      }
      if (await probe(1200, true)) {
        state = 'ready';
        detail = `${modelPath.split('/').pop()} · -c ${ctx} -ngl ${gpuLayers}`;
        return;
      }
    }
    state = 'error';
    detail = `等待模型就绪超时（${Math.round(startTimeoutMs / 1000)}s）。`;
    throw new Error(`${detail}\n${tail.join('\n')}`);
  }

  /** Idempotent: concurrent callers share one start attempt. */
  function ensure() {
    if (state === 'ready' || state === 'external') return Promise.resolve();
    if (!pending) {
      pending = (async () => {
        if (await probe()) {
          state = 'external';
          detail = `复用已在 ${origin} 运行的服务`;
          return;
        }
        if (!autoStart) {
          state = 'error';
          detail = `未检测到 ${origin} 上的模型服务，且已禁用自动启动（AUTO_START=0）。`;
          throw new Error(detail);
        }
        await launch();
      })()
        .catch((err) => {
          if (state !== 'ready' && state !== 'external') state = 'error';
          throw err;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const done = await Promise.race([
      new Promise((r) => child.once('exit', () => r(true))),
      delay(3000).then(() => false),
    ]);
    if (!done && child.exitCode === null) child.kill('SIGKILL');
  }

  return {
    ensure,
    stop,
    probe,
    /** Auth header for the server we spawned; empty when adopting an external one. */
    authHeaders: () => (apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    status: () => ({ state, detail, origin, modelPath, ctx, gpuLayers, log: tail.slice(-12) }),
  };
}
