# 译稿台 — local translation desk

A browser front end for the Hy-MT2-1.8B GGUF models in this repository. Type or paste text, or import a `.txt` / `.md` file, and it translates automatically. Each request is capped at **2000 characters**.

Zero npm dependencies, no build step — plain ES modules served by a small Node HTTP server, which also starts `llama-server` for you.

> 中文文档：[README_CN.md](./README_CN.md)

## Requirements

| | |
|---|---|
| **Node ≥ 20** | `node -v` — uses the built-in `fetch`, ES modules, `node:test`-free stdlib only. |
| **`llama-server`** | From [llama.cpp](https://github.com/ggml-org/llama.cpp). The app launches it. `brew install llama.cpp`, or build from source. Check with `llama-server --version`. |
| **One GGUF file** | ~1.1 GB for Q4_K_M. See below. |

No `npm install` — there are no dependencies.

## Quick start

```bash
cd webapp
node fetch-model.mjs      # downloads Hy-MT2-1.8B-Q4_K_M.gguf (~1.1 GB) into the repository root
npm start                 # → http://127.0.0.1:8787
```

Open the printed URL. The status chip shows the model loading on the first request (a few seconds); after that a translation returns in well under a second.

## Getting the model

The weights are not in this git repository (they are ~3.9 GB, over GitHub's free LFS allowance), so a fresh clone has no model and `npm start` would have nothing to load. `fetch-model.mjs` downloads one from HuggingFace.

```bash
node fetch-model.mjs                      # Q4_K_M (default, recommended)
node fetch-model.mjs --model Q6_K         # or Q8_0, or `all`
node fetch-model.mjs --list               # every file in the repo, with sizes
node fetch-model.mjs --out /data/models   # somewhere else (then set MODEL_PATH, below)
node fetch-model.mjs --verify             # re-hash an existing file instead of trusting its size
```

It is safe to re-run:

- **Resumes.** An interrupted download leaves `<name>.part`; the next run continues with an HTTP `Range` request.
- **Verifies.** Final size is always checked, and the LFS `sha256` is verified when the endpoint publishes it. A mismatch deletes the file and fails loudly rather than letting a corrupt model reach `llama-server`.
- **Repairs.** If a file is present but the wrong size — the classic result of an interrupted download — it is reported and re-fetched instead of being skipped.

### `huggingface.co` is unreachable?

The script falls back to the `hf-mirror.com` mirror automatically when the primary endpoint does not answer. To skip the probe and go straight to a mirror:

```bash
export HF_ENDPOINT=https://hf-mirror.com    # or: --endpoint https://hf-mirror.com
node fetch-model.mjs
```

Manual alternative: download a file from [huggingface.co/tencent/Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF) in a browser and place it in the repository root. Keep the file name intact — the server looks for `Hy-MT2-1.8B-Q4_K_M.gguf` by default.

## Using the desk

| | |
|---|---|
| **Input** | Type or paste into 原文; or 导入 `.txt` / `.md`; or drag a file anywhere on the window. Importing translates immediately. |
| **Auto-translate** | Typing translates once you pause (~0.7 s). `⌘↵` / `Ctrl+Enter` translates now; `Esc` or 停止 cancels mid-stream. |
| **Target** | 译为 offers the 38 languages from the model card, by full name in both English and Chinese. |
| **Markdown** | 保留 Markdown 结构 keeps headings, lists, links, tables and code fences intact and translates only the visible text — the model card's "Structured Data" prompt. Imports of `.md` switch this on automatically. |
| **The 2000 limit** | Counted in characters. Over the limit the desk refuses and says by how much — it never silently truncates. Enforced in the browser *and* in the server. |
| **Output** | Streams in as it is produced, with first-token and total timings. 复制 copies it; 下载 saves `.txt` or `.md` depending on the mode. |
| **Encoding** | `.txt` files are read as UTF-8, falling back to GBK (common for Windows exports) when they are not valid UTF-8. |

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port for this front end. |
| `MODEL_ORIGIN` | `http://127.0.0.1:8080` | Where `llama-server` lives. An existing server there is **adopted and never killed**. |
| `MODEL_PATH` | `<repo>/Hy-MT2-1.8B-Q4_K_M.gguf` | Exact model file to load. |
| `MODEL_NAME` | `Hy-MT2-1.8B-Q4_K_M.gguf` | Used instead of `MODEL_PATH` to pick a different quant in the repo root. |
| `LLAMA_SERVER` | `llama-server` | Path to the binary, if it is not on `PATH`. |
| `CTX` | `8192` | Context length. **Raise carefully**: the model's own 262144 default costs ~16 GiB of KV cache. |
| `NGL` | `0` | Layers to offload to the GPU. CPU (`0`) is the tested default. |
| `THREADS` | unset | CPU threads; unset lets llama.cpp decide. |
| `AUTO_START` | `1` | `0` never spawns a server — expects one at `MODEL_ORIGIN`. |
| `MODEL_TIMEOUT_MS` | `180000` | How long to wait for the model to become ready. |

Two behaviours worth knowing:

- If anything already answers on `MODEL_ORIGIN`, it is reused and left alone; only a server this app spawned is shut down on exit.
- A spawned server is started with `--api-key <random per run>`, so another local page cannot drive your model. The key stays in the Node process and is never sent to the browser.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `未找到可执行文件 llama-server` | Install llama.cpp, or point `LLAMA_SERVER` at the binary. |
| `未找到模型文件：…` | Run `node fetch-model.mjs`, or set `MODEL_PATH`. |
| `EADDRINUSE` on start | Something holds the port: `PORT=8899 npm start`. |
| First translation is slow | The model is loading; the chip shows progress. Later requests are fast. |
| Machine gets sluggish after start | The KV cache is sized by `CTX`; lower it (e.g. `CTX=4096`). |
| `llama-server` exits immediately | Read the log tail printed in the error — usually a truncated or wrong-format `.gguf`. Re-run `fetch-model.mjs`; it verifies sha256. |
| Model loads but output is garbage | Wrong file, or an interrupted download that predates the checks: `node fetch-model.mjs --verify`. |

## Static build (no backend)

`npm run build:pages` copies `public/` to `docs/`, which any static host can serve — or you can serve it locally with `python3 -m http.server -d docs`. In that mode there is no Node server, so the browser talks directly to an OpenAI-compatible endpoint you enter on the page.

One hard limitation: a page served over HTTPS from a public origin **cannot** call `http://127.0.0.1`. Browsers block public-to-local requests (local network access policy) and the request fails immediately with `Failed to fetch`; `llama-server` also does not send the `Access-Control-Allow-Private-Network` opt-in header. Use local mode (`npm start`) for a local model, and the static build only with an HTTPS endpoint that is publicly reachable.

## How it fits together

```
browser  →  POST /api/translate (SSE out)
              → validate with public/limit.mjs      (413 before any streaming)
              → lib/model.mjs ensures llama-server   (adopt or spawn, per-run API key)
              → public/translate.mjs builds the prompt from the model card's templates
              → streams /v1/chat/completions
         ←  event: start / delta / done | error
```

`public/limit.mjs`, `public/languages.mjs` and `public/translate.mjs` are imported by **both** the browser and the Node server, so the 2000-character rule, the language names and the prompt text cannot drift between the two.
