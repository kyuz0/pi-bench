#!/bin/bash
# Shared helper: resolve which OCI container engine to use.
#
# Source this file from any script that needs to run containers:
#   source "$(dirname "${BASH_SOURCE[0]}")/scripts/container-engine.sh"
#
# It exports:
#   $ENGINE     — the engine binary to invoke ("docker" or "podman")
#   $TTY_ARGS   — "-it" when attached to a terminal, "-i" otherwise
#
# Override the auto-detection with:
#   CONTAINER_ENGINE=podman ./run-swe-bench.sh ...
#
# Docker is preferred when both are installed so that existing docker users keep
# their image cache; podman is used automatically when docker is unavailable.
# Both engines are API-compatible for everything these scripts do (build, run,
# pull, volume create, --init, --network host, --env-file, ":z" bind mounts).

if [ -z "$CONTAINER_ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE="docker"
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE="podman"
  else
    echo "[ERROR] No container engine found. Install docker or podman," >&2
    echo "[ERROR] or set CONTAINER_ENGINE to the binary you want to use." >&2
    exit 1
  fi
fi

if ! command -v "$CONTAINER_ENGINE" >/dev/null 2>&1; then
  echo "[ERROR] CONTAINER_ENGINE='$CONTAINER_ENGINE' is not on PATH." >&2
  exit 1
fi

ENGINE="$CONTAINER_ENGINE"

# Only request a pseudo-TTY when stdin actually is one. Passing -t without a
# terminal (CI, cron, `< /dev/null`) makes docker abort and makes podman emit
# "The input device is not a TTY" warnings.
if [ -t 0 ]; then
  TTY_ARGS="-it"
else
  TTY_ARGS="-i"
fi

export ENGINE TTY_ARGS
