#!/usr/bin/env bash
# Runs a validation suite or probe against a real Ceedling release in Docker. The suites drive the
# engine compiled into out-test/, with the sidecar's Node and node_modules volume, so build the
# tests in the sidecar first; `just validate` does both. See docs/Development.md.
#
# usage: run.sh <ceedling-version> <suite> [args...]
#   <ceedling-version>  a throwtheswitch/madsciencelab-plugins image tag, e.g. 1.2.1
#   <suite>             stress, coverage, gated, layout, latency, all, or a probe:
#                       probe:fixes, probe:overlap, probe:syscalls
#   [args...]           passed to the suite (stress and coverage take seconds, maxInFlight, seed);
#                       `all` passes them to stress and coverage only
# The Justfile passes the sidecar's image and node_modules volume names; these defaults match it.
set -euo pipefail
version=${1:?usage: run.sh <ceedling-version> <suite> [args...]}
suite=${2:?usage: run.sh <ceedling-version> <suite> [args...]}
shift 2
repo=$(cd "$(dirname "$0")/../.." && pwd)
image="vscode-ceedling-validate:$version"
sidecar_image=${SIDECAR_IMAGE:-vscode-ceedling-sidecar}
node_modules_volume=${NODE_MODULES_VOLUME:-vscode-ceedling-node-modules}
suites=(stress coverage gated layout latency)
case $suite in
    all | probe:fixes | probe:overlap | probe:syscalls) ;;
    *) [[ " ${suites[*]} " == *" $suite "* ]] || { echo "error: no suite or probe named '$suite'" >&2; exit 1; } ;;
esac

if ! command -v docker >/dev/null; then
    echo "error: the validation suites need Docker; run them from the host, not inside the sidecar" >&2
    exit 1
fi
if [ ! -f "$repo/out-test/tests/validation/harness.js" ]; then
    echo "error: out-test/ has no compiled suites; run 'just validate', or 'just _run \"npm run -s build:tests\"' first" >&2
    exit 1
fi
docker build -q -t "$image" --build-arg CEEDLING="$version" --build-arg SIDECAR="$sidecar_image" -f "$repo/sidecar/validate.Dockerfile" "$repo/sidecar" >/dev/null

# The repo and node_modules are read-only. Each run builds its projects in the container's own /ws,
# so nothing is left on the host.
container=(docker run --rm -e CEEDLING_DECORATORS=false -v "$repo":/workspace:ro -v "$node_modules_volume":/workspace/node_modules:ro)
run_suite() {
    echo "=== Ceedling $version: $*"
    "${container[@]}" --entrypoint node "$image" "/workspace/out-test/tests/validation/$1.js" "${@:2}"
}

case $suite in
    all)
        status=0
        for one in "stress" "stress --shared-build-root" "coverage" "gated" "layout" "latency" "latency --vendored"; do
            # Only stress and coverage take numbers. The other suites reject them.
            case $one in stress* | coverage*) args=("$@") ;; *) args=() ;; esac
            # shellcheck disable=SC2086 # each entry is a suite and its arguments
            run_suite $one ${args[@]+"${args[@]}"} || status=1
        done
        exit $status
        ;;
    probe:syscalls) "${container[@]}" --user root --entrypoint sh "$image" /workspace/tests/validation/probes/syscalls.sh ;;
    probe:*) "${container[@]}" --entrypoint sh "$image" "/workspace/tests/validation/probes/${suite#probe:}.sh" ;;
    *) run_suite "$suite" "$@" ;;
esac
