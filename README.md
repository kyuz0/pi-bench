# Pi-Bench

A lightweight, customizable benchmark runner for `pi-coding-agent`, inspired by `opencode-bench`.

## Overview
`pi-bench` automates the process of testing an AI coding agent against real-world tasks. It does this by:
1. Cloning a target repository to a temporary workspace (or using a pre-configured SWE-bench container).
2. Checking out a specific baseline commit.
3. Spinning up `pi-coding-agent` in the workspace with a predefined task prompt.
4. Letting the agent use its tools (`read`, `bash`, `edit`, `write`) to complete the task.
5. Capturing the generated patch (`git diff`).
6. **Running the test suite** — either from a `testCommand` (curated tasks) or SWE-bench `FAIL_TO_PASS` tests (inside the container).
7. Using a secondary LLM **Judge** (Gemini) to evaluate the patch and provide a rationale for the score.

## Setup

First, install the required dependencies (using `bun` or `npm`):
```bash
bun install
```

## Defining Tasks

Benchmark tasks are defined as simple JSON files. See `tasks/curated/easy.json` for a reference:
```json
{
  "id": "curated-easy",
  "repo": "chalk/chalk",
  "commit": "v5.3.0",
  "prompt": "There is a typo in the README.md file in the `chalk` repository. Please find the typo 'colos' and fix it to 'colors'.",
  "expectedDiff": "diff --git a/README.md b/README.md\n...",
  "testCommand": "npm install && npm test"
}
```

*Note: `solutionCommit`, `expectedDiff`, and `testCommand` are optional. If `testCommand` is provided, the runner will execute it in the workspace after the agent completes. A `0` exit code automatically grants a perfect score, bypassing the subjective LLM judge.*

## Included Datasets

`pi-bench` supports multiple datasets to evaluate the agent's performance.

### SWE-bench Verified Mini (Recommended)
A highly curated subset of 50 verified tasks from the SWE-bench dataset. This is the recommended dataset for rapid, high-quality evaluation as it tests a broad set of capabilities without taking days to run.

To download and import this dataset directly from HuggingFace, simply run:
```bash
./scripts/download-swe-mini.sh
```
This will automatically generate the 50 task files inside the `tasks/verified-mini/` directory.



---

## Running Benchmarks

### SWE-bench Tasks (Recommended)

SWE-bench tasks run inside **official SWE-bench Docker containers** from `ghcr.io/epoch-research/swe-bench.eval.x86_64.*`. Each task gets its own container with:
- The correct Python version (e.g. Python 3.6 for Django 3.1, Python 3.8+ for Sphinx)
- All dependencies pre-installed
- The repository checked out at the right commit in `/testbed`

This eliminates the environment mismatch problems that plague host-side execution.

#### Pre-pull containers (optional)
Download all 49 container images upfront (~2.4 GB download, ~6 GB on disk due to heavy layer sharing):
```bash
./scripts/pull-swe-containers.sh
```

#### Provider Setup & Execution

You can configure and use both local and cloud-based models as the backend engine for the `pi-coding-agent`.

##### Local Providers (`llama.cpp`, `lemonade`, `ds4`, and `vllm`)
Local providers are configured in `models.json` in the project root. By default:
- `llama.cpp` expects a local server running at `http://localhost:8080/v1`
- `ds4` and `vllm` expect a local server running at `http://localhost:8000/v1`
- `lemonade` expects a Lemonade Server running at `http://localhost:13305/v1`

When using a local provider, you do not need to specify a model name via `--model`. `pi-bench` asks the server which model it is currently serving and formats the results directory accordingly. Whatever model your local server is currently running will be used.

Detection differs per provider because the servers differ:
- `llama.cpp`, `ds4`, `vllm` serve exactly one model, so `/v1/models` is authoritative.
- `lemonade` is a multi-model server: its `/v1/models` lists the entire installable catalogue (including image, audio and TTS models), so pi-bench reads `/api/v1/health` instead, which reports the model actually resident on the GPU (`model_loaded`) along with the context window it was loaded with.


**Example: Running with `llama.cpp`**
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llama.cpp \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45
```


**Example: Running with `ds4`**
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider ds4 \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45
```

**Example: Running with `lemonade`**
Lemonade serves whichever model is currently loaded, so no `--model` is needed:
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider lemonade \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45
```

To benchmark a *different* Lemonade model, load it first and re-run - the runner picks up whatever is resident:
```bash
# list the LLMs you have installed
curl -s localhost:13305/api/v1/models | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin)['data'] if 'tool-calling' in m.get('labels', [])]"

# load one, then check what is resident
curl -s -X POST localhost:13305/api/v1/load -H 'Content-Type: application/json' -d '{"model_name":"Qwen3.6-35B-A3B-GGUF"}'
curl -s localhost:13305/api/v1/health | python3 -c "import json,sys; print(json.load(sys.stdin)['model_loaded'])"
```
Only models labelled `tool-calling` can drive the coding agent. You can also pin one explicitly with `--model Qwen3.6-35B-A3B-GGUF`; Lemonade will load it on demand.

**Example: Running with `vllm` and specifying a model**
If your vLLM instance hosts multiple models or you want to explicitly select a configuration from `models.json`, use the `--model` flag:
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider vllm \
  --model RedHatAI/Qwen3.6-27B-FP8 \
  --judge-model google/gemini-3.1-pro-preview \
  --platform dual-r9700 \
  --rocm-version 7.2.4 \
  --timeout 45
```

##### Cloud Providers (`openrouter`)
For cloud providers like OpenRouter, the provider endpoint is queried. Because these platforms host many models, you **must** specify which model to run using the `--model` flag.

**Example: Running with OpenRouter**
```bash
./run-swe-bench.sh tasks/verified-mini/django__django-11790.json \
  --provider openrouter \
  --model deepseek/deepseek-v4-flash \
  --judge-model google/gemini-3.1-pro-preview \
  --platform openrouter \
  --timeout 30
```

#### How SWE-bench evaluation works
After the agent finishes editing code, the runner:
1. **Applies the test patch** from the SWE-bench dataset (adds the regression tests)
2. **Runs the `FAIL_TO_PASS` tests** inside the container using the correct Python and test runner
3. **Score is ground truth** — if the tests pass, `score = 1`; if they fail, `score = 0`
4. **The LLM Judge** (Gemini) receives both the diff and the test results, and provides a human-readable rationale explaining *why* the fix worked or didn't

This combines the objectivity of SWE-bench's test-based evaluation with the explainability of an LLM judge.

#### Choosing a judge

There are two kinds of judge.

**1. API judge (default)** - a model from the pi-ai registry, called over HTTP with an API key from `.env`:
```bash
--judge-model google/gemini-3.1-pro-preview   # needs GEMINI_API_KEY
--judge-model anthropic/claude-opus-4-6       # needs ANTHROPIC_API_KEY
--judge-model openai/gpt-5.2                  # needs OPENAI_API_KEY
```
This runs *inside* the SWE-bench container, which is why the key has to be in `.env` (the container gets it via `--env-file`).

**2. CLI judge** - the `claude` (Claude Code) or `codex` CLI in headless mode:
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider lemonade \
  --judge-cli claude --judge-model opus \
  --platform strix-halo \
  --timeout 45
```
```bash
./run-swe-bench.sh tasks/verified-mini/ \
  --provider lemonade \
  --judge-cli codex --judge-model gpt-5.2-codex \
  --platform strix-halo \
  --timeout 45
```
With `--judge-cli`, judging **runs on the host, not in the container**: the container writes `judgeScore: null`, then `run-swe-bench.sh` immediately scores that task on the host and fills the score in before deciding whether to retry (`--pass N` keeps working). The CLI reuses the login you already have, so no credentials ever enter a container and no API key is needed. Requirements:
- `claude` or `codex` must be on your `PATH` and logged in (`claude` / `codex login`).
- `--judge-model` is passed through to the CLI verbatim, so use *its* names: `opus`, `sonnet`, `haiku` for claude; `gpt-5.2-codex`, `gpt-5.1-codex-max` for codex. Omit it to use the CLI's default model.

Each judge call is hermetic: it runs in a throwaway directory with tools disabled (`claude`) or sandboxed read-only (`codex`), so project `CLAUDE.md` / `AGENTS.md` and MCP servers do not leak into the verdict. `codex` is additionally pinned to a JSON output schema.

#### Re-judging an existing run

Judging is separable from running, so you can re-score results without re-running the agent - useful when comparing judges or when a judge call failed:
```bash
# score anything still pending
bun run scripts/judge-results.ts benchmark_results/strix-halo/Qwen3_6-35B-A3B-GGUF_results --judge-cli claude

# re-score everything with a different judge
bun run scripts/judge-results.ts benchmark_results/strix-halo/Qwen3_6-35B-A3B-GGUF_results \
  --judge-cli codex --force

# or with an API model
bun run scripts/judge-results.ts <results-dir> --judge-model google/gemini-3.1-pro-preview --force
```
The scored file records which judge produced the verdict in `judgedBy`, and `summary.json` is recomputed. Judges genuinely disagree on borderline cases (the judge prompt is allowed to override a failing test when the fix is practically correct), so `judgedBy` matters when comparing runs.

### Curated Tasks (Docker sandbox)

For non-SWE-bench tasks (curated, custom), use the Docker runner:
```bash
./run-docker.sh tasks/curated/ \
  --provider llama.cpp \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --timeout 30
```

### Local Execution (Use with Caution)
Running the benchmark locally executes the agent on your host machine.
```bash
bun run src/index.ts tasks/curated/easy.json
```

---

## CLI Reference

### Provider & Model Flags

| Flag | Description | Default |
|---|---|---|
| `--provider <name>` | Inference provider: `llama.cpp`, `lemonade`, `ds4`, `vllm`, or `openrouter` | `llama.cpp` |
| `--model <model-id>` | Model ID within the provider (e.g. `deepseek/deepseek-v4-flash`) | Auto-detected |
| `--judge-model <provider/id>` | Judge model (e.g. `google/gemini-3.1-pro-preview`). With `--judge-cli`, the CLI's own model name (e.g. `opus`) | Same as agent |
| `--judge-cli <claude\|codex>` | Judge with the `claude` or `codex` CLI on the host instead of an API model | - |
| `--port <port>` | Override the local server port | `8080` (llama.cpp), `8000` (ds4, vllm), `13305` (lemonade) |
| `--engine <name>` | Backward-compatible alias for `--provider` | — |

**Local providers** (`llama.cpp`, `lemonade`, `ds4`, `vllm`) auto-detect which model the server is currently serving, so `--model` is only needed to force a specific configuration from `models.json` or to pick a model on a multi-model server. Detection uses `/v1/models` for single-model servers and `/api/v1/health` for `lemonade`, whose `/v1/models` lists its whole installable catalogue rather than what is loaded.

A detected model does not need an entry in `models.json`: pi-bench registers it on the fly using the provider's settings (and the context window the server reports), so new quants work without editing config.

**Cloud providers** (`openrouter`) require `--model` to specify which model to use, since the provider may host many models.

**Backward compatibility**: `--model openrouter/deepseek/deepseek-v4-flash` (without `--provider`) still works — the provider is parsed from the first path segment.

### Other Flags

| Flag | Description | Default |
|---|---|---|
| `--platform <id>` | Save results to `benchmark_results/<platform>/` | — |
| `--model-tag <tag>` | Append a suffix to the results directory (e.g. `mtp`) | — |
| `--rocm-version <ver>`| ROCm version running the backend | `7.2.4` |
| `--context <tokens>` | Override model context window size for this run | From `models.json` |
| `--timeout <minutes>` | Agent timeout per task | `30` |
| `--pass <N>` | Number of attempts to make per task (retries on failure) | `1` |
| `--defer-judge` | Skip judging; leave `judgeScore: null` for a later `scripts/judge-results.ts` pass | - |

### Examples

```bash
# Local llama.cpp (auto-detects model from server)
./run-swe-bench.sh tasks/verified-mini/ \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# Lemonade Server, judged by the local Claude Code CLI (no API key needed)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider lemonade \
  --judge-cli claude --judge-model opus \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# Local ds4 server on custom port
./run-swe-bench.sh tasks/verified-mini/ \
  --provider ds4 --port 9000 \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# Local vllm specifying an exact model ID
./run-swe-bench.sh tasks/verified-mini/ \
  --provider vllm --model cyankiwi/MiniMax-M2.7-AWQ-4bit \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --rocm-version 7.2.4 \
  --timeout 45

# OpenRouter cloud
./run-swe-bench.sh tasks/verified-mini/ \
  --provider openrouter --model deepseek/deepseek-v4-flash \
  --judge-model google/gemini-3.1-pro-preview \
  --platform openrouter \
  --timeout 30

# Single task, backward-compat style
./run-swe-bench.sh tasks/verified-mini/django__django-11790.json \
  --model openrouter/deepseek/deepseek-v4-flash \
  --judge-model google/gemini-3.1-pro-preview \
  --platform openrouter \
  --timeout 30

# Override context window for a run (e.g. limit to 90k tokens)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider vllm --model cyankiwi/MiniMax-M2.7-AWQ-4bit \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --context 90000 \
  --timeout 45

# Run with 2 attempts per task (pass@2)
./run-swe-bench.sh tasks/verified-mini/ \
  --provider llama.cpp \
  --judge-model google/gemini-3.1-pro-preview \
  --platform strix-halo \
  --pass 2 \
  --timeout 45
```

---

## Configuring Models

If you need to configure custom API endpoints or model parameters (like max tokens or context windows), edit the `models.json` file in the project root.

### API Keys
Create a `.env` file in the root `pi-bench/` directory with your API keys:
```
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
```
Both `run-docker.sh` and `run-swe-bench.sh` automatically pass this file into the container.

---

## Results & Multi-Platform Dashboard

When a single run completes, it outputs a JSON artifact to the current directory (e.g. `results-curated-easy.json`).

When running a **batch** (providing a directory like `tasks/verified-mini/`), `pi-bench` automatically generates a uniquely named directory for the results based on the model (e.g., `Qwen3_6-35B-A3B-UD-Q8_K_XL_gguf_results/`).

### Populating the Dashboard
`pi-bench` includes a dynamic HTML dashboard that can track results across multiple hardware platforms. To get your results onto the dashboard:

1. **Create your platform metadata**: If it's a new platform, create a folder for it inside `benchmark_results/` and add a `platform.json` describing your hardware:
   ```bash
   mkdir -p benchmark_results/r9700
   ```
   *benchmark_results/r9700/platform.json*:
   ```json
   {
     "id": "r9700",
     "name": "Radeon 9700",
     "gpu": "Radeon 9700 16GB",
     "ram": "32GB DDR5"
   }
   ```
2. **Run your benchmark with the `--platform` flag**:
   ```bash
   ./run-swe-bench.sh tasks/verified-mini/ \
     --judge-model google/gemini-3.1-pro-preview \
     --platform r9700
   ```
   *This automatically routes the results folder (e.g. `Qwen3_6..._results`) right into `benchmark_results/r9700/`.*
   
3. **Generate the report**:
   This script parses all new results in `benchmark_results/` and compiles them into a single `docs/data.json` file. The frontend dashboard (`app.js`) requires this JSON file to display data.
   ```bash
   bun run scripts/generate-report.ts
   ```

4. **Serve the dashboard**:
   The dashboard is a static website. Serve the `docs/` folder, open your browser (e.g., `http://localhost:8082`), and the Vue frontend (`app.js`) will automatically load the updated `data.json`.
   ```bash
   python3 -m http.server 8082 -d docs/
   ```
