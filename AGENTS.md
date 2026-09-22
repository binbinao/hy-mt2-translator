# Repository Guidelines

## Project Overview

This is a **HuggingFace-style model release repo**, not an application: GGUF quantizations of Tencent's Hy-MT2-1.8B multilingual translation model, plus the reference fine-tuning code for the Hy-MT2 family.

- Weights: three LFS-tracked quantizations at the repo root (Q4_K_M, Q6_K, Q8_0).
- Training code: `train/` — two parallel SFT stacks (bare DeepSpeed, LLaMA-Factory) plus offline checkpoint conversion/validation tooling.
- Docs: bilingual model cards (`README.md` / `README_CN.md`) and training guides (`train/README.md` / `train/README_CN.md`).
- **No application source, no test framework, no CI, no package manifest, no linter config.** Verification is manual (see [Testing & QA](#testing--qa)).
- License: Apache-2.0 (`LICENSE.txt`). Base model: `tencent/Hy-MT2-1.8B`. Remote: `hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF`, branch `main`.

Changes here are almost always docs, training configs/scripts, or new quantized artifacts — not application logic.

## Architecture & Data Flow

Two independent subsystems that never import each other.

### 1. Weight artifacts (repo root)

All three `.gguf` files share one geometry — verified by parsing their metadata:

| Key | Value |
|---|---|
| `general.architecture` | `hunyuan-dense` |
| GGUF version / tensors | 3 / 354 |
| Layers / embed / FFN | 32 / 2048 / 6144 |
| Heads / KV heads / head_dim | 16 / 4 / 128 (GQA 4) |
| `context_length` | 262144, `rope.scaling.type = none` |
| `rope.freq_base` | 11158840.0 |
| Tokenizer | GPT-2 BPE, `hunyuan-dense` pre-tokenizer, vocab 120818 |
| BOS / EOS / PAD / SEP | 120000 / 120020 / 120002 / 120007 |
| `general.file_type` | 15 (Q4_K_M), 18 (Q6_K), 7 (Q8_0) |

- `tokenizer.chat_template` is **embedded and byte-identical across all three files** — it is the authority for prompt formatting: system content follows `<｜hy_begin▁of▁sentence｜>` with `<｜hy_place▁holder▁no▁3｜>` appended, users are `<｜hy_User｜>{content}`, assistants `<｜hy_Assistant｜>{content}<｜hy_place▁holder▁no▁2｜>`.
- `general.sampling.{temp,top_p,top_k}` = 0.7 / 0.8 / 20 are embedded (a Hunyuan extension); llama.cpp applies them automatically.
- Minor metadata drift: Q4_K_M carries `general.finetune: "1.8B"` and `general.name: "1.8B"`, while Q6_K/Q8_0 carry `general.name: "Global_Step_300"`.

### 2. Training stacks (`train/`)

Two stacks achieving the same goal with opposite integration styles:

- **Bare DeepSpeed** (`train/deepspeed_support/`) — self-contained HF `Trainer` scripts launched by the `deepspeed` CLI. `train.py` handles MoE/HYV3 and carries four monkey-patches; `train_dense.py` is a near-duplicate for dense models with the MoE patches stripped.
- **LLaMA-Factory** (`train/llama_factory_support/`) — thin `torchrun` wrappers (`train_hy_v3.py`, `train_hy_dense.py`) that apply patches and template registration as **import side effects**, monkey-patch `llamafactory.train.sft.workflow.run_sft` to inject `HYV3PatchCallback`, then call `run_exp()`. torchrun-per-worker is deliberate: the `llamafactory-cli` launcher respawns workers and would lose the patches.

Flow (bare stack): CLI flags → `HfArgumentParser` dataclasses → `AutoTokenizer(trust_remote_code=True)` → model load (`train.py` silently falls back to a random-init model when weights are missing; `train_dense.py` raises instead) → optional LoRA/freeze → `Trainer` → `train()`.

Flow (LF stack): torchrun → wrapper imports templates + patches → `_patched_run_sft` appends the callback → `run_exp()` reads the YAML → LLaMA-Factory runs the rest.

Checkpoint pipeline (`train/tools/`, `convert_zero_to_hf.sh`):

```
DeepSpeed ZeRO shards
  → convert_zero_to_hf.sh            (zero_to_fp32.py + config copy + heredoc reload/save)
  → HF "inner" format                (per-expert 2D keys)
  → convert_ckpt_to_outer.py         (key renames + fuse experts to 3D + rebuild index)
  → HF "outer" format
  → check_converted.py               (validates index, keys, shapes, NaN/Inf, orphans)
```

Data flow: `train/data/example_data.jsonl` + a `dataset_info.json` registration + a registered chat template name. All three must agree — the YAML's `dataset:` and `template:` fields are the join points.

### 3. Local translation frontend (`webapp/`)

A zero-dependency Node 22 tool that turns one of the GGUFs into a browser translation desk: type or import `.txt`/`.md`, it translates automatically, hard-capped at 2000 characters.

```
browser  →  POST /api/translate (SSE out)
              → validate with public/limit.mjs   (413 before any streaming)
              → lib/model.mjs ensures llama-server is up (auto-spawn, per-run API key)
              → public/translate.mjs builds the model-card prompt, streams /v1/chat/completions
         ←  event: start / delta / done | error
```

- `public/limit.mjs`, `public/languages.mjs` and `public/translate.mjs` are **isomorphic**: the browser imports them as `/limit.mjs` etc., the server imports the same files from disk. The 2000-character budget, the language table and the prompt text therefore cannot drift between client and server.
- `fetch-model.mjs` exists because the weights are deliberately absent from git; it is the only supported way a fresh clone gets a runnable model.
- The model server is spawned with `--api-key <per-run uuid>` and `--no-webui`, so a stray page on the machine cannot drive the model port; the key never reaches the browser.
- Prompts come from the model card's templates (`public/translate.mjs`): the default translation template, plus the "Structured Data 1" template when Markdown structure must be preserved. No system message — the model has no default system prompt.

## Key Directories

| Path | Purpose |
|---|---|
| `*.gguf` (root) | Released quantizations (Git LFS). Never edit these by hand. |
| `imgs/` | `logo-en.png`, `logo-zh.png`, `main_result.png` only. |
| `webapp/` | Node translation frontend: `server.mjs`, `lib/`, `public/`, `fetch-model.mjs`. Not an npm package — no dependencies, no build step. |
| `train/deepspeed_support/` | Bare DeepSpeed stack: `train.py`, `train_dense.py`, `merge_lora_weight.py`, 4 launcher `.sh`, 5 `ds_*.json`. |
| `train/llama_factory_support/` | LLaMA-Factory stack: 2 entry wrappers, 3 template/patch modules, 6 SFT YAMLs, 3 `ds_*.json`, 3 launcher `.sh`, `dataset_info.json`. |
| `train/tools/` | Standalone checkpoint CLI utilities (stdlib `argparse`). |
| `train/data/` | Single example dataset, `example_data.jsonl`. |

## Development Commands

### Inference (verified on this machine)

```bash
llama-completion --model Hy-MT2-1.8B-Q4_K_M.gguf \
  -p "Translate the following segment into Chinese, without additional explanation: Hello" \
  --jinja -ngl 0 -c 512 -n 64 -st
```

Confirmed working: Homebrew `llama.cpp 0.4.1` loaded `Hy-MT2-1.8B-Q4_K_M.gguf` and returned `你好，你怎么样？` (~1.7 s load, 211 tok/s prompt, 58.75 tok/s generation, `-ngl 0`, 8 threads, M1 Pro). Because the chat template is embedded, `llama-completion` auto-enables conversation mode — suppress it with `-no-cnv`, set a system prompt with `-sys`.

> **The root README's "depends on STQ kernel, PR #22836" warning does not apply to these files.** `hunyuan-dense` has been in upstream llama.cpp since 2025-08-01 (`src/llama-arch.cpp`, `LLM_ARCH_HUNYUAN_DENSE`); PR #22836 adds `STQ1_0` for the separate *1.25-bit* release. Do not repeat that README claim as a requirement here — but do keep it if you are editing a 1.25-bit/STQ doc.

Always cap context: the 262144 default implies a ~16 GiB KV cache (32 layers × 2 × 4 KV heads × 128 dim × 262144 × 2 B). Use `-c 4096` unless long context is genuinely needed.

Benchmark: `llama-bench -m <file>.gguf -ngl 0` (note the README's `model_zoo/model.gguf` path does not exist here).

### Translation frontend

```bash
cd webapp
node fetch-model.mjs      # ~1.1 GB weights into the repo root; the repo ships code, not weights
npm start                 # → http://127.0.0.1:8787  (no dependencies to install)
```

The weights are never committed here — `*.gguf` is in `.gitignore`, and a fresh clone has no model until `fetch-model.mjs` runs. That script is resumable, verifies size plus LFS `sha256`, repairs truncated files instead of skipping them, and falls back to `hf-mirror.com` when `huggingface.co` is unreachable (`HF_ENDPOINT` / `--endpoint` to choose). A truncated `.gguf` still parses its metadata but fails in llama.cpp with `failed to load model` — the size/hash check is what catches it.

`npm start` only serves the UI. The first translation (or startup) spawns `llama-server` against `../Hy-MT2-1.8B-Q4_K_M.gguf` with `-c 8192 -ngl 0`, and that child is killed when the Node process exits. Environment knobs: `PORT`, `MODEL_ORIGIN`, `MODEL_PATH` / `MODEL_NAME`, `LLAMA_SERVER`, `CTX`, `NGL`, `THREADS`, `AUTO_START=0` (never spawn — expect an existing server), `MODEL_TIMEOUT_MS`.

If a server already answers on `MODEL_ORIGIN`, it is adopted and never killed. Raise `CTX` rather than removing it: the model's own 262144 default costs ~16 GiB of KV cache.

### Training

```bash
pip install -r train/requirements.txt

# Bare DeepSpeed stack (run from train/deepspeed_support/)
bash train_dense.sh 1.8B          # dense full; 1.8B → 1 GPU + ds_zero2_no_offload.json, 7B → 2 GPU + ds_zero3_no_offload.json
bash train_dense_lora.sh 1.8B     # dense LoRA
bash train.sh                     # MoE (HYV3) full
bash train_lora.sh                # MoE LoRA
IP_LIST="10.0.0.1,10.0.0.2" bash train_dense.sh 7B   # multi-node

# LLaMA-Factory stack (run from train/llama_factory_support/)
bash train_lf_dense.sh                                          # default hy_dense_1_8b_full_sft.yaml
YAML_FILE=hy_dense_7b_lora_sft.yaml bash train_lf_dense.sh
bash train_lf.sh                                                # MoE, default hy_v3_full_sft.yaml

# Post-training
python3 merge_lora_weight.py --base_model_path <ckpt> --adapter_model_path <adapter> \
        --output_path <out> --save_dtype bf16      # bf16|fp32|fp16; writes pytorch_model.bin, not safetensors
```

Before running a launcher, edit its placeholder variables: `model_path` / `path_to_dense_1_8b_model`, `tokenizer_path`, `train_data_file`, `output_path`, and for LF scripts `YAML_FILE`, `IP_LIST`, `MASTER_PORT`, `HOST_GPU_NUM`.

### Checkpoint tooling

```bash
python train/tools/convert_ckpt_to_outer.py --input_dir <inner> --output_dir <outer> [--workers 8]
python train/tools/check_converted.py <outer_dir> [--spot-check 3]   # exit 0 = PASSED, 1 = FAILED
```

## Code Conventions & Common Patterns

**Model-specific behavior is injected by monkey-patching**, not subclassing. Follow this when adding model variants:

- Module function replacement: `transformers.integrations.deepspeed._load_state_dict_into_zero3_model`.
- Class method replacement: `HYV3TopKRouter.forward`, `HYV3ForCausalLM.save_pretrained`.
- Global builtin replacement: `torch.nn.functional.linear` → dtype-safe wrapper (affects *every* linear in the process).
- LLaMA-Factory workflow replacement: `llamafactory.train.sft.workflow.run_sft`.
- Guard repeats with a module-global flag (e.g. `_router_patch_applied`) and make failures non-fatal: `try/except ImportError` → warn and continue.

**Python**

- CLI args are `@dataclass` + `transformers.HfArgumentParser` (`ModelArguments`, `DataArguments`, `TrainingArguments`) in the training scripts; plain `argparse` in `train/tools/` and `merge_lora_weight.py`.
- Logging is `print(..., flush=True)` guarded by `torch.distributed.get_rank() == 0`; tools use bracket prefixes `[ERROR]` / `[WARN]` / `[SKIP]` / `[FATAL]` plus `sys.exit(0|1)`.
- `sys.path.insert(0, ...)` at the top of every training script; `IGNORE_INDEX = -100` for label masking.
- Loss masking relies on **magic token strings** that must track the model's tokenizer: MoE uses `<｜hy_Assistant｜>` … `<tokenizer.eos_token>`; dense non-7B uses `<｜hy_Assistant｜>` … `<｜hy_place▁holder▁no▁2｜>`; dense 7B uses `<|extra_0|>` … `<|eos|>`.
- Checkpoint key mapping is encoded twice, in opposite directions: `train.py` (inner ↔ outer on load/save) and `convert_ckpt_to_outer.py` (`_KEY_RENAMES`, `_EXPERT_KEY_RE`). **Change both together.**
- Failures use `raise FileNotFoundError` / `raise ValueError`; there are no `assert`s.
- Dense and MoE scripts are copy-paste twins — if you fix a bug in one, check the other (`torch_dtype` vs `dtype` init kwarg, `min_lr`, `max_seq_length`, `lora_alpha` already diverge).

**Shell**

- `#!/bin/bash`; `set -euo pipefail` only in `llama_factory_support/` scripts (`convert_zero_to_hf.sh` uses `set -e`); the `deepspeed_support/` scripts have no `set` flags.
- `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` in LF scripts vs `$(dirname "$0")` in DeepSpeed scripts.
- LF scripts: `SCREAMING_SNAKE` env vars with defaults (`HOST_GPU_NUM=8`, `IP_LIST=${IP_LIST:-"127.0.0.1"}`, `MASTER_PORT=${MASTER_PORT:-29500}`). DeepSpeed scripts: lowercase variables edited in place.
- A ~30-line NCCL/IB env block is copy-pasted into all six training scripts; `NET_TYPE="high"` is hardcoded, so the `low` branch is dead code.

**Configs**

- DeepSpeed JSON filenames encode the strategy: `ds_zero{2,3}[_{offload,no_offload}][_no_auto].json`.
- The same filename in the two directories is **not** the same config — `ds_zero3_offload.json` differs meaningfully between `deepspeed_support/` and `llama_factory_support/`. Always reference the full path.
- SFT YAMLs use `### model` / `### method` / `### dataset` / `### output` / `### train` comment groups. Full SFT uses lr `1.0e-5`; LoRA uses `2.0e-4`, rank 64 / alpha 128 / dropout 0.05 on `q_proj,k_proj,v_proj,o_proj`.
- Naming: `hy_v3` = MoE/HYV3, `hy_dense_1_8b` / `hy_dense_7b` = dense. Template names in the YAML must match `register_template(name=...)`; dataset names must match keys in `dataset_info.json`.

## Important Files

| File | Role |
|---|---|
| `README.md` | Authoritative model card: prompt templates, supported languages, inference commands, sampling params, YAML front matter (`base_model`, `license`). `README_CN.md` mirrors it without front matter. |
| `train/README.md` | Training guide — hardware table, multi-node SSH/Docker setup, script selection, LoRA merge, documented caveats. |
| `train/requirements.txt` | Training deps (`transformers>=5.6.0`, `torch>=2.10.0`, `deepspeed>=0.18.7`, `peft>=0.18.1`, `accelerate>=1.11.0`, `flash-attn`, …). Minimums only, no lockfile. |
| `train/deepspeed_support/train.py` | MoE/HYV3 SFT entry point; the monkey-patch hub. |
| `train/deepspeed_support/train_dense.py` | Dense SFT entry point. |
| `train/llama_factory_support/train_hy_v3.py`, `train_hy_dense.py` | torchrun entry points; import templates + patches before `run_exp()`. |
| `train/llama_factory_support/hy_v3_patches.py` | Router dtype fix + `HYV3PatchCallback` (`use_reentrant=True`, tokenizer files copied on save). |
| `train/llama_factory_support/hy_*_template.py` | Registers LF templates `hy_v3`, `hy_dense_1_8b`, `hy_dense_7b`. |
| `train/llama_factory_support/dataset_info.json` | Dataset registry for sharegpt `{"messages": [...]}` JSONL. |
| `train/llama_factory_support/convert_zero_to_hf.sh` | ZeRO → HF conversion (3 steps, embedded Python heredoc). |
| `train/tools/convert_ckpt_to_outer.py`, `check_converted.py` | Checkpoint format conversion and validation. |
| `webapp/server.mjs`, `webapp/lib/model.mjs`, `webapp/public/translate.mjs` | Frontend server, model-server lifecycle, prompt construction + upstream streaming. |
| `webapp/fetch-model.mjs` | Downloads the GGUF weights from HuggingFace (resumable, size + sha256 verified, mirror fallback). |
| `webapp/README.md`, `webapp/README_CN.md` | The frontend's usage guide: quick start, configuration, troubleshooting. |
| `webapp/public/limit.mjs`, `webapp/public/languages.mjs` | Isomorphic limit policy and language table — imported by both the browser and the server. |
| `.gitattributes` | Git LFS rules; the three `.gguf` files and `imgs/main_result.png` are listed individually. |

## Runtime/Tooling Preferences

- **Inference:** llama.cpp. Stock upstream is sufficient for these quants (verified); `llama-bench` / `llama-completion` / `llama-cli` / `llama-server`. CPU-only operation with `-ngl 0` is the documented path and is fast enough for translation.
- **Training:** Linux + CUDA, `python3`, the `deepspeed` CLI (bare stack) or `torchrun` (LF stack), a separate [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory) source checkout (not in `requirements.txt`), and `flash-attn` (YAMLs request `fa2`). Documented hardware at `max_seq_length = 8192`: 1.8B → 1×24 GB; 7B full → 2×80 GB; 30B-A3B → 8×80 GB.
- **Tooling constraints:** LF scripts export `DISABLE_VERSION_CHECK=1` because the stack targets a newer `transformers` than LLaMA-Factory expects. The patched imports reach into private APIs (`transformers.integrations.deepspeed._load_state_dict_into_zero3_model`), so pin/verify the transformers version before blaming the training code.
- **Git LFS 3.8.0** is required (installed here). New quantized artifacts must be added to `.gitattributes` by **exact filename** — there is no `*.gguf` glob. `HY_MT2_0_Technical_Report.pdf` and `HY_MT2_0_Report.pdf` are LFS-listed but absent from the repo.
- **Text files** (`*.jsonl`, `*.yaml`, `*.sh`, `*.py`) are intentionally not LFS-tracked.

## Testing & QA

There is **no test suite, no CI, no linter, and no type checker** in this repo. Do not invent commands like `pytest` or `npm test`. Verification is manual and task-specific:

1. **Checkpoint conversion** — `python train/tools/check_converted.py <outer_dir>` is the only automated check that exists. It exits `0` on `Result: PASSED (…)` and `1` on `Result: FAILED (…)`, validates `model.safetensors.index.json`, expected dense/MoE/MTP keys per `config.json`, fused expert shapes `(num_experts, 2·expert_hidden, hidden_size)` / `(num_experts, hidden_size, expert_hidden)`, NaN/Inf, and orphan shards (≤128 B treated as merge residue, safe to delete). It spot-checks only `--spot-check N` shards (default 3) and never compares values against the source checkpoint.
2. **Inference changes** — run the model and read the output, e.g. the `llama-completion … --jinja` command above. That is the acceptance test for artifact or prompt-template changes.
3. **Template changes** — there is no automated comparison of the repo's LLaMA-Factory templates against the GGUF/model `chat_template.jinja`. Diff rendered output manually (`tokenizer.apply_chat_template` vs LLaMA-Factory encoding) before trusting an edit.
4. **Data/code changes** — the code has no unit tests; exercise the affected path with a throwaway script or a short real run, then delete it. `train/data/example_data.jsonl` is never schema-checked by any script.
5. **Frontend changes** — still no test suite; `webapp/` is verified by driving the real page. Fast checks: `node --check` each module, and remember the browser-facing modules are plain ES modules the server also imports, so a syntax error takes down `/api/config` too. The behaviours worth re-walking after an edit: auto-translate fires once the input settles; exactly 2000 characters passes and 2001 is refused (413 from the API, disabled button in the UI); an over-limit file import is accepted into the editor but **not** translated; the drop overlay appears on dragenter and hides on dragleave; and a completed translation can be copied and downloaded. For visuals, screenshot the page and inspect it — `hidden` toggles are the classic trap here, because an author `display` rule silently beats `[hidden]`.

## Known Drift (do not propagate)

Recurring inconsistencies that already exist; fix them when you touch the file, but do not treat them as intended behavior:

- `README.md`: `top_p: 0.6` for 1.8B/7B, while the GGUF metadata carries `top_p = 0.8` (llama.cpp uses the embedded value).
- `README.md`: the PR #22836 / STQ-kernel requirement (applies to the 1.25-bit release only) and the dead `model_zoo/model.gguf` path; both READMEs link a nonexistent `./IFMTBench/`.
- Both READMEs: prose claims "33 languages" while the table lists 38.
- `train/README.md` references "Hy3 preview" where `train/README_CN.md` says "Hy-MT", and points at a "Quick Start Guide" that does not exist. A bias-weight warning mentions "Hunyuan-Large".
- `dataset_info.json`: `hy_v3_demo.file_name` is `"../example_data.jsonl"` (wrong level; siblings correctly use `"../data/example_data.jsonl"`).
- `convert_zero_to_hf.sh` references `$PROJECT_ROOT/a3b_ckpt` (absent) and hardcodes `checkpoint-39`. `train.sh` / `train_lora.sh` use `tokenizer_path=../models` and `train_data_file=example_data.jsonl` (CWD-relative; fails unless run from `deepspeed_support/`). `hy_v3_*_sft.yaml` use `model_name_or_path: ../hf` (placeholder).
- `train_lora.sh`'s comment recommends ZeRO-2 offload but selects `ds_zero2_no_offload.json`; the DeepSpeed and LLaMA-Factory stacks disagree on LoRA `min_lr` (1e-5 vs the YAML's `min_lr_rate: 0.1`).
- `train/tools/check_converted.py` key-check defaults (`num_hidden_layers` 80, `num_experts` 192) target a larger HYV3 variant than the 1.8B geometry—missing `config.json` keys silently fall back to those.
