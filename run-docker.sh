#!/bin/bash
set -e

# Works with either docker or podman. See scripts/container-engine.sh.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/container-engine.sh"

# Build the container image
echo "[INFO] Building pi-bench image with $ENGINE..."
$ENGINE build -t pi-bench-runner .

# Ensure .pi exists in home directory to mount
mkdir -p ~/.pi

# Run the benchmark
# -v $(pwd):/pi-bench:z mounts the pi-bench directory
# -w /pi-bench sets the working directory to pi-bench
echo "[INFO] Running pi-bench inside $ENGINE..."
ENV_ARGS=""
if [ -f .env ]; then
    ENV_ARGS="--env-file .env"
fi

$ENGINE run --init --rm $TTY_ARGS --network host $ENV_ARGS \
    -v "$(pwd):/pi-bench:z" \
    -w /pi-bench \
    pi-bench-runner \
    bun run src/index.ts "$@"
