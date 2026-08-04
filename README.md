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

SWE-bench tasks run inside **official SWE-bench containers** from `ghcr.io/epoch-research/swe-bench.eval.x86_64.*`. Each task gets its own container with:
- The correct Python version (e.g. Python 3.6 for Django 3.1, Python 3.8+ for Sphinx)
- All dependencies pre-installed
- The repository checked out at the right commit in `/testbed`

This eliminates the environment mismatch problems that plague host-side execution.

#### Container engine

All container scripts work with either **Docker** or **Podman** (including rootless Podman).
The engine is auto-detected: Docker is used when available, otherwise Podman. Force a
specific engine with the `CONTAINER_ENGINE` variable:

```bash
CONTAINER_ENGINE=podman ./run-swe-bench.sh tasks/verified-mini/
```

Under rootless Podman the container's `root` maps to your host user, so results written
into the bind-mounted project directory are owned by you — no `sudo` or `chown` needed.

#### Pre-pull containers (optional)
Download all 49 container images upfront (~2.4 GB download, ~6 GB on disk due to heavy layer sharing):
```bash
./scripts/pull-swe-containers.sh
```

#### Provider Setup & Execution

You can configure and use both local and cloud-based models as the backend engine for the `pi-coding-agent`.

##### Local Providers (`llama.cpp`, `ds4`, and `vllm`)
Local providers are configured in [models.json](file:///home/kyuz0/Documents/Projects/pi-bench/models.json) in the project root. By default:
- `llama.cpp` expects a local server running at `http://localhost:8080/v1`
- `ds4` and `vllm` expect a local server running at `http://localhost:8000/v1`

When using a local provider, you do not need to specify a model name via `--model`. `pi-bench` will automatically query the local provider's `/v1/models` endpoint to retrieve the active model name and format the results directory accordingly. Whatever model your local server is currently running will be used.


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

### Curated Tasks (container sandbox)

For non-SWE-bench tasks (curated, custom), use the container runner (`run-docker.sh`,
which works with Docker or Podman):
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
| `--provider <name>` | Inference provider: `llama.cpp`, `ds4`, `vllm`, or `openrouter` | `llama.cpp` |
| `--model <model-id>` | Model ID within the provider (e.g. `deepseek/deepseek-v4-flash`) | Auto-detected |
| `--judge-model <provider/id>` | Judge model (e.g. `google/gemini-3.1-pro-preview`) | Same as agent |
| `--port <port>` | Override the local server port | `8080` (llama.cpp), `8000` (ds4, vllm) |
| `--engine <name>` | Backward-compatible alias for `--provider` | — |

**Local providers** (`llama.cpp`, `ds4`, `vllm`) auto-detect the model name by querying the local server's `/v1/models` endpoint. No `--model` needed unless you want to force a specific configuration from `models.json` or target a specific model on a multi-model server.

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

### Examples

```bash
# Local llama.cpp (auto-detects model from server)
./run-swe-bench.sh tasks/verified-mini/ \
  --judge-model google/gemini-3.1-pro-preview \
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
