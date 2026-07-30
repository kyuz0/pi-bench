#!/bin/bash
set -e

# Run pi-bench tasks inside official SWE-bench evaluation containers.
# Each task runs in its own container with the correct Python version and dependencies.
#
# Usage:
#   ./run-swe-bench.sh tasks/verified-mini/ --provider ds4 --judge-model google/gemini-3.1-pro-preview --platform strix-halo
#   ./run-swe-bench.sh tasks/verified-mini/ --provider lemonade --judge-cli claude --platform strix-halo
#   ./run-swe-bench.sh tasks/verified-mini/django__django-12209.json --provider openrouter --model deepseek/deepseek-v4-flash
#
# The script:
#   1. Iterates over task files in the given directory (or runs a single task file)
#   2. For each task, launches the corresponding SWE-bench container
#   3. Installs bun + pi-bench deps inside the container (cached via Docker volume)
#   4. Runs the benchmark: agent works in /testbed, then FAIL_TO_PASS tests are executed
#   5. Results are written back to the host via the bind-mounted pi-bench directory
#   6. With --judge-cli, judging happens on the HOST right after each attempt, so the
#      claude/codex CLI uses your existing login and no credentials enter the container

TARGET="${1:?Usage: ./run-swe-bench.sh <task-file-or-dir> [extra-args...]}"
shift

PASS_COUNT=1
JUDGE_CLI=""
JUDGE_MODEL=""
EXTRA_ARGS=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --pass)
      PASS_COUNT="$2"
      shift 2
      ;;
    --judge-cli)
      JUDGE_CLI="$2"
      # The container declares the judge but defers it; the host runs it.
      EXTRA_ARGS="$EXTRA_ARGS --judge-cli $2 --defer-judge"
      shift 2
      ;;
    --judge-model)
      JUDGE_MODEL="$2"
      EXTRA_ARGS="$EXTRA_ARGS --judge-model $2"
      shift 2
      ;;
    *)
      EXTRA_ARGS="$EXTRA_ARGS $1"
      shift
      ;;
  esac
done

if [ -n "$JUDGE_CLI" ] && ! command -v "$JUDGE_CLI" >/dev/null 2>&1; then
  echo "[ERROR] --judge-cli $JUDGE_CLI requested but '$JUDGE_CLI' is not in PATH on the host."
  exit 1
fi
REGISTRY="ghcr.io/epoch-research/swe-bench.eval.x86_64"
PI_BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Create persistent bun cache volume (shared across all container runs)
docker volume create pi-bench-bun-cache 2>/dev/null || true

# Collect env file args
ENV_ARGS=""
if [ -f "$PI_BENCH_DIR/.env" ]; then
  ENV_ARGS="--env-file $PI_BENCH_DIR/.env"
fi

# Collect task files
TASK_FILES=()
if [ -d "$TARGET" ]; then
  for f in "$TARGET"/*.json; do
    [ -f "$f" ] && TASK_FILES+=("$f")
  done
else
  TASK_FILES+=("$TARGET")
fi

if [ ${#TASK_FILES[@]} -eq 0 ]; then
  echo "[ERROR] No task JSON files found in $TARGET"
  exit 1
fi

TOTAL=${#TASK_FILES[@]}
COUNT=0
PASSED=0
FAILED=0

# Determine results directory on the host to check for cached results
RESULTS_DIR=$(bun run src/index.ts --print-output-dir "$TARGET" $EXTRA_ARGS 2>/dev/null || true)

echo "========================================================"
echo "[INFO] SWE-bench Runner — $TOTAL tasks queued"
if [ -n "$RESULTS_DIR" ]; then
  echo "[INFO] Results directory: $RESULTS_DIR"
fi
echo "========================================================"

for task_file in "${TASK_FILES[@]}"; do
  COUNT=$((COUNT + 1))
  TASK_ID=$(python3 -c "import json; print(json.load(open('$task_file'))['id'])")

  # Skip if result already exists (check on host to avoid docker startup overhead)
  if [ -n "$RESULTS_DIR" ] && [ -f "$RESULTS_DIR/results-${TASK_ID}.json" ]; then
    echo ""
    echo "========================================================"
    echo "[$COUNT/$TOTAL] Task: $TASK_ID"
    echo "[INFO] Skipping $TASK_ID, result already exists."
    echo "========================================================"
    PASSED=$((PASSED + 1))
    continue
  fi

  IMAGE="${REGISTRY}.${TASK_ID}:latest"

  echo ""
  echo "========================================================"
  echo "[$COUNT/$TOTAL] Task: $TASK_ID"
  echo "         Image: $IMAGE"
  echo "========================================================"

  REL_TASK_FILE=$(python3 -c "import os; print(os.path.relpath('$(realpath "$task_file")', '$(realpath "$PI_BENCH_DIR")'))")

  for ATTEMPT in $(seq 1 $PASS_COUNT); do
    if [ $PASS_COUNT -gt 1 ]; then
      echo "[INFO] Starting attempt $ATTEMPT of $PASS_COUNT for $TASK_ID"
    fi

    # The container runs as root against a bind-mounted repo, so results would come back
    # root-owned - unusable for the host judge pass and awkward for git. Hand them back.
    if [ -n "$RESULTS_DIR" ]; then
      CHOWN_TARGETS="/pi-bench/$RESULTS_DIR"
    else
      CHOWN_TARGETS="/pi-bench/benchmark_results /pi-bench/results"
    fi

    # Run container and tee output to a temp file so we can extract the results dir
    LOGFILE=$(mktemp /tmp/pi-bench-log.XXXXXX)
    docker run --init -it --rm --network host $ENV_ARGS \
      -v "$PI_BENCH_DIR:/pi-bench:z" \
      -v "pi-bench-bun-cache:/root/.bun" \
      "$IMAGE" \
      bash -c "
        set -e

        # Install unzip + bun (cached after first run via volume)
        if [ ! -f /root/.bun/bin/bun ]; then
          echo '[SETUP] Installing bun...'
          apt-get update -qq && apt-get install -y -qq unzip >/dev/null 2>&1
          curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
          echo '[SETUP] bun installed.'
        fi
        export PATH=/root/.bun/bin:\$PATH

        # Ensure unzip is available (bun cache might exist from a previous run but unzip might not be in this container)
        which unzip >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq unzip >/dev/null 2>&1; }

        # Install pi-bench dependencies (fast if node_modules exists from bind mount)
        cd /pi-bench && bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null

        # Activate the SWE-bench testbed conda environment so 'python' resolves
        # to the correct version (e.g. Python 3.6 for Django, 3.8+ for Sphinx)
        source /opt/miniconda3/etc/profile.d/conda.sh
        conda activate testbed

        # Run the benchmark (keep its exit code: 2 means the backend is unreachable)
        set +e
        bun run src/index.ts $REL_TASK_FILE $EXTRA_ARGS
        RC=\$?
        set -e

        # Give the results back to the host user
        chown -R $(id -u):$(id -g) $CHOWN_TARGETS 2>/dev/null || true
        exit \$RC
      " 2>&1 | tee "$LOGFILE"

    EXIT_CODE=${PIPESTATUS[0]}

    # Capture the results directory from container output (first occurrence only)
    if [ -z "$RESULTS_DIR" ]; then
      RESULTS_DIR=$(grep -m1 'Saving results to directory:' "$LOGFILE" | sed 's/.*Saving results to directory: //' | tr -d '\r' || true)
    fi
    rm -f "$LOGFILE"

    if [ $EXIT_CODE -eq 2 ]; then
      echo "[FATAL] Inference backend is unreachable or crashed. Aborting entire benchmark run."
      exit 2
    fi

    # Judge on the host, before the retry decision below, so the claude/codex CLI can
    # use the login it already has instead of needing credentials inside the container.
    if [ -n "$JUDGE_CLI" ] && [ -n "$RESULTS_DIR" ] && [ -f "$RESULTS_DIR/results-${TASK_ID}.json" ]; then
      echo "[INFO] Judging $TASK_ID on the host with the $JUDGE_CLI CLI..."
      JUDGE_ARGS=(--judge-cli "$JUDGE_CLI" --no-summary)
      [ -n "$JUDGE_MODEL" ] && JUDGE_ARGS+=(--judge-model "$JUDGE_MODEL")
      bun run "$PI_BENCH_DIR/scripts/judge-results.ts" "$RESULTS_DIR/results-${TASK_ID}.json" "${JUDGE_ARGS[@]}" \
        || echo "[WARN] Host judge failed for $TASK_ID - score left pending."
    fi

    # Rename the outputs for this attempt
    if [ -n "$RESULTS_DIR" ]; then
      mv "$RESULTS_DIR/results-${TASK_ID}.json" "$RESULTS_DIR/results-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || true
      mv "$RESULTS_DIR/transcript-${TASK_ID}.json" "$RESULTS_DIR/transcript-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || true

      # Check if this attempt succeeded
      JUDGE_SCORE=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print(r.get('judgeScore', 0))" "$RESULTS_DIR/results-${TASK_ID}-attempt${ATTEMPT}.json" 2>/dev/null || echo "0")
      if [ "$JUDGE_SCORE" = "1" ]; then
        break
      fi
    fi
  done

  # Combine attempts and determine pass/fail
  python3 -c "
import json, sys, os, shutil
results_dir = sys.argv[1]
task_id = sys.argv[2]
pass_count = int(sys.argv[3])

attempts = []
best_attempt = None
succeeded_at = None

for a in range(1, pass_count + 1):
    res_path = os.path.join(results_dir, f'results-{task_id}-attempt{a}.json')
    if os.path.exists(res_path):
        with open(res_path, 'r') as f:
            data = json.load(f)
            attempts.append(data)
            best_attempt = a
            if data.get('judgeScore') == 1:
                succeeded_at = a
                break

if attempts:
    final_data = attempts[-1].copy() # use the last run as base
    final_data['attempts'] = attempts
    final_data['succeededAtAttempt'] = succeeded_at
    
    with open(os.path.join(results_dir, f'results-{task_id}.json'), 'w') as f:
        json.dump(final_data, f, indent=2)
        
    # Copy the best transcript to standard name for legacy support
    best_trans = os.path.join(results_dir, f'transcript-{task_id}-attempt{best_attempt}.json')
    final_trans = os.path.join(results_dir, f'transcript-{task_id}.json')
    if os.path.exists(best_trans):
        shutil.copy2(best_trans, final_trans)
" "$RESULTS_DIR" "$TASK_ID" "$PASS_COUNT"

  # Count passes/fails based on the final combined file
  FINAL_SCORE=$(python3 -c "import json, sys; r=json.load(open(sys.argv[1], 'r')); print(r.get('judgeScore', 0))" "$RESULTS_DIR/results-${TASK_ID}.json" 2>/dev/null || echo "0")
  if [ "$FINAL_SCORE" = "1" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "[WARN] Task $TASK_ID failed after $ATTEMPT attempts"
  fi
done

echo ""
echo "========================================================"
echo "[INFO] SWE-bench Runner Complete!"
echo "[INFO] Tasks: $TOTAL | Succeeded: $PASSED | Failed: $FAILED"
echo "========================================================"

# Generate aggregate summary.json from all individual result files.
# Each container writes its own summary.json with only 1 task, overwriting the previous.
# This step reads all results-*.json and builds the real aggregate.
if [ -n "$RESULTS_DIR" ] && [ -d "$RESULTS_DIR" ]; then
  echo "[INFO] Generating aggregate summary from $RESULTS_DIR ..."
  python3 -c "
import json, glob, os, re, sys

results_dir = sys.argv[1]
# Exclude per-attempt files (results-<id>-attempt<N>.json); they are folded into the
# combined results-<id>.json above and would otherwise be counted as extra tasks.
result_files = sorted(
    f for f in glob.glob(os.path.join(results_dir, 'results-*.json'))
    if not re.search(r'-attempt\d+\.json$', f)
)

if not result_files:
    print('[WARN] No result files found, skipping summary generation.')
    sys.exit(0)

results = []
passed = 0
total_duration = 0

for f in result_files:
    with open(f) as fh:
        r = json.load(fh)
        results.append(r)
        if r.get('judgeScore') == 1:
            passed += 1
        total_duration += r.get('durationMs', 0)

summary = {
    'totalTasks': len(results),
    'passedTasks': passed,
    'passRate': passed / len(results) if results else 0,
    'totalDurationMs': total_duration,
    'averageDurationMs': total_duration / len(results) if results else 0,
    'results': results
}

summary_path = os.path.join(results_dir, 'summary.json')
with open(summary_path, 'w') as fh:
    json.dump(summary, fh, indent=2)

print(f'[INFO] Aggregate summary: {passed}/{len(results)} passed ({summary[\"passRate\"]*100:.1f}%)')
print(f'[INFO] Summary saved to {summary_path}')
" "$RESULTS_DIR"
else
  echo "[WARN] Could not determine results directory for aggregate summary."
fi
