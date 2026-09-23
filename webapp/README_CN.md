# 译稿台 — 本地翻译台

本仓库 Hy-MT2-1.8B GGUF 模型的浏览器前端。输入或粘贴文本、导入 `.txt` / `.md` 文件，即自动翻译，单次上限 **2000 字符**。

零 npm 依赖、无需构建：原生 ES 模块 + 一个很小的 Node 服务，同时负责帮你把 `llama-server` 拉起来。

> English: [README.md](./README.md)

## 环境要求

| | |
|---|---|
| **Node ≥ 20** | `node -v`。用到内置 `fetch`、ES 模块。 |
| **`llama-server`** | 来自 [llama.cpp](https://github.com/ggml-org/llama.cpp)，由本应用启动。可 `brew install llama.cpp`，或自行编译。用 `llama-server --version` 确认。 |
| **一份 GGUF 模型** | Q4_K_M 约 1.1 GB，见下。 |

不需要 `npm install`——没有依赖。

## 快速开始

```bash
cd webapp
node fetch-model.mjs      # 下载 Hy-MT2-1.8B-Q4_K_M.gguf（约 1.1 GB）到仓库根目录
npm start                 # → http://127.0.0.1:8787
```

打开提示的地址即可。首次请求会加载模型（几秒），之后每次翻译都远快于 1 秒。

## 获取模型

权重不在本 git 仓库中（约 3.9 GB，超出 GitHub 免费 LFS 配额），因此刚 clone 下来是没有模型文件的，`npm start` 会因找不到模型而失败。`fetch-model.mjs` 负责从 HuggingFace 下载。

```bash
node fetch-model.mjs                      # 默认 Q4_K_M（推荐）
node fetch-model.mjs --model Q6_K         # 也可 Q8_0，或 all
node fetch-model.mjs --list               # 列出仓库内所有文件及大小
node fetch-model.mjs --out /data/models   # 存到别处（之后用 MODEL_PATH 指定）
node fetch-model.mjs --verify             # 对已存在的文件重新校验哈希，而不只看大小
```

可以反复执行：

- **断点续传**。中断会留下 `<name>.part`，下次运行用 HTTP `Range` 从断点继续。
- **校验**。始终校验最终大小；端点提供 LFS `sha256` 时一并校验。不匹配会删除文件并明确报错，绝不让损坏的模型进入 `llama-server`。
- **修复**。文件存在但大小不对（下载中断的典型后果）时会明确提示并重新下载，而不是跳过。

### 连不上 `huggingface.co`？

主端点无响应时，脚本会自动改用 `hf-mirror.com` 镜像。想跳过探测直接走镜像：

```bash
export HF_ENDPOINT=https://hf-mirror.com    # 或：--endpoint https://hf-mirror.com
node fetch-model.mjs
```

手动方式：用浏览器从 [huggingface.co/tencent/Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF) 下载，放到仓库根目录，文件名保持不变（默认查找 `Hy-MT2-1.8B-Q4_K_M.gguf`）。

## 使用说明

| | |
|---|---|
| **输入** | 在「原文」中输入或粘贴；或点「导入 .txt / .md」；或把文件拖到窗口任意位置。导入后会立即翻译。 |
| **自动翻译** | 输入停顿约 0.7 秒后自动开始；`⌘↵` / `Ctrl+Enter` 立即翻译；`Esc` 或「停止」可中断流式输出。 |
| **目标语言** | 「译为」仅提供中文、日语、英语和德语，中英文全名对照。 |
| **Markdown** | 开启「保留 Markdown 结构」后，标题、列表、链接、表格与代码块原样保留，只翻译可见文本（即模型卡的 Structured Data 提示词）。导入 `.md` 会自动开启。 |
| **2000 上限** | 按字符计数。超出直接拒绝并告知超出多少，绝不静默截断。浏览器与服务端双重校验。 |
| **输出** | 流式逐字输出，并显示首字与总耗时。「复制」取走文本，「下载」按模式保存为 `.txt` 或 `.md`。 |
| **编码** | `.txt` 优先按 UTF-8 读取；若不是合法 UTF-8，则回退到 GBK（Windows 导出的常见编码）。 |

## 配置

以下环境变量均可选：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 前端端口。 |
| `MODEL_ORIGIN` | `http://127.0.0.1:8080` | `llama-server` 地址。该地址上已有服务时会**直接复用且绝不终止**。 |
| `MODEL_PATH` | `<repo>/Hy-MT2-1.8B-Q4_K_M.gguf` | 指定要加载的模型文件。 |
| `MODEL_NAME` | `Hy-MT2-1.8B-Q4_K_M.gguf` | 未设 `MODEL_PATH` 时，用于换用仓库根目录下的其他量化版本。 |
| `LLAMA_SERVER` | `llama-server` | 可执行文件不在 `PATH` 时指定路径。 |
| `CTX` | `8192` | 上下文长度。**谨慎调大**：模型自带的 262144 默认值需要约 16 GiB 的 KV 缓存。 |
| `NGL` | `0` | 卸载到 GPU 的层数。默认纯 CPU，是经过验证的配置。 |
| `THREADS` | 未设 | CPU 线程数；未设时由 llama.cpp 自行决定。 |
| `AUTO_START` | `1` | `0` 表示不自动启动，只使用 `MODEL_ORIGIN` 上的服务。 |
| `MODEL_TIMEOUT_MS` | `180000` | 等待模型就绪的最长时间。 |

两个值得了解的行为：

- 若 `MODEL_ORIGIN` 上已有服务，则复用且不做任何干预；只有本应用自己启动的进程才会在退出时被回收。
- 自动启动的服务会带上 `--api-key <每次随机>`，避免本机其他页面调用你的模型；该密钥只存在于 Node 进程内，不会下发到浏览器。

## 常见问题

| 现象 | 处理 |
|---|---|
| `未找到可执行文件 llama-server` | 安装 llama.cpp，或用 `LLAMA_SERVER` 指向该文件。 |
| `未找到模型文件：…` | 运行 `node fetch-model.mjs`，或设置 `MODEL_PATH`。 |
| 启动时报 `EADDRINUSE` | 端口被占用：`PORT=8899 npm start`。 |
| 第一次翻译很慢 | 正在加载模型，顶部状态会显示进度；之后很快。 |
| 启动后机器变卡 | KV 缓存由 `CTX` 决定，调小即可（如 `CTX=4096`）。 |
| `llama-server` 立即退出 | 看报错里附带的日志尾部，通常是 `.gguf` 被截断或格式不对。重跑 `fetch-model.mjs`，它会校验 sha256。 |
| 模型能加载但输出乱码 | 文件不对，或早于校验机制的不完整下载：`node fetch-model.mjs --verify`。 |

## 静态版本（无后端）

`npm run build:pages` 会把 `public/` 复制到 `docs/`，可交给任意静态托管服务，也可以本地起一个：`python3 -m http.server -d docs`。这种模式没有 Node 服务，浏览器直接请求你在页面上填写的 OpenAI 兼容端点。

有一个硬性限制：公网 HTTPS 页面**无法**访问 `http://127.0.0.1`。浏览器会按本地网络访问策略拦截公网到本地的请求，现象是立即 `Failed to fetch`；`llama-server` 也不会返回 `Access-Control-Allow-Private-Network` 许可头。本机模型请用本地模式（`npm start`），静态版本只适合配合公网可访问的 HTTPS 端点。

## CSV 批量本地化

本地模式打开 `/batch.html`，粘贴带表头的 CSV 并选择目标语言。服务会自动识别可翻译列，跳过 ID、SKU、URL、邮箱、纯数字和代码类字段，保护占位符，并同时返回译文 CSV 与审校报告。

相同流程也可以通过 API 调用：

```bash
curl http://127.0.0.1:8787/api/batch/csv \
  -H 'content-type: application/json' \
  -d '{"target":"de","csv":"sku,name,description\nA-100,Wireless Mouse,Compact ergonomic mouse"}'
```

可选字段：

- `columns`：明确指定要翻译的表头名或零基列号。
- `glossary`：`[{"source":"Wireless Mouse","target":"Funkmaus"}]`。
- `delimiter`：`,`、`;` 或 `\t`。
- `concurrency`：并发数，默认 `2`。

单次限制为 200 个翻译单元格、每格 2000 字符、整批 20000 字符。

## 结构

```
浏览器  →  POST /api/translate（SSE 输出）
              → 用 public/limit.mjs 校验        （超限时在任何流式输出之前返回 413）
              → lib/model.mjs 确保 llama-server  （复用或启动，附每次随机的 API key）
              → public/translate.mjs 按模型卡模板拼提示词
              → 流式请求 /v1/chat/completions
         ←  event: start / delta / done | error
```

`public/limit.mjs`、`public/languages.mjs`、`public/translate.mjs` 同时被**浏览器和 Node 服务**导入，因此 2000 字符上限、语言名称与提示词在两端不可能不一致。
