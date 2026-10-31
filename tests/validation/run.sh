#!/usr/bin/env bash
# Runs a validation suite or probe against a real Ceedling release in Docker. The suites drive the
# engine compiled into out-test/, with the sidecar's Node and node_modules volume, so build the
# tests in the sidecar first; `just validate` does both. See docs/Development.md.
#
# usage: run.sh <ceedling-version | ceedling.gem> <suite> [args...]
#   <ceedling-version>  a throwtheswitch/madsciencelab-plugins image tag, e.g. 1.2.1
#   <ceedling.gem>      the absolute path to a Ceedling .gem file, which then replaces the Ceedling of
#                       CEEDLING_BASE (1.2.1)
#   <suite>             stress, coverage, gated, layout, latency, mixed, upgrade, all, or a probe:
#                       probe:fixes, probe:overlap, probe:syscalls. `list` prints what `all` runs.
#   [args...]           passed to the suite (stress and coverage take seconds, maxInFlight, seed);
#                       `all` passes them to stress and coverage only
# CEEDLING_GEM, the path to a .gem file, adds its installation to /opt/ceedling beside the published
# ones, for the suites that select another Ceedling. The Justfile passes the sidecar's image and
# node_modules volume names; these defaults match it.
set -euo pipefail
usage='usage: run.sh <ceedling-version | ceedling.gem> <suite> [args...]'
version=${1:?$usage}
suite=${2:?$usage}
shift 2
repo=$(cd "$(dirname "$0")/../.." && pwd)
sidecar_image=${SIDECAR_IMAGE:-vscode-ceedling-sidecar}
node_modules_volume=${NODE_MODULES_VOLUME:-vscode-ceedling-node-modules}
# What `all` runs, one suite and its flags per entry. Every suite is in it.
all=("stress" "stress --shared-build-root" "coverage" "gated" "layout" "latency" "latency --vendored" "mixed" "upgrade")
suites=()
for entry in "${all[@]}"; do suites+=("${entry%% *}"); done
case $suite in
    list) printf '%s\n' "${all[@]}"; exit 0 ;;
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

# A gem reaches the image through its own build context, empty without one. BuildKit keys the copy
# on the context's contents. Given no context, it can reuse a gem build's copy of the Dockerfile's
# empty default, and a plain image then holds that gem. The gem's content hash names the image, so
# a rebuilt gem never reuses an image built from an older one.
gem=${CEEDLING_GEM:-} base=$version mode=opt
if [[ -n $gem && $gem != *.gem ]]; then
    echo "error: CEEDLING_GEM must name a .gem file, not '$gem'" >&2; exit 1
fi
if [[ $version == *.gem ]]; then
    [ -z "$gem" ] || { echo "error: give a gem either as the version or as CEEDLING_GEM, not both" >&2; exit 1; }
    gem=$version base=${CEEDLING_BASE:-1.2.1} mode=install
fi
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
label=$version
if [ -n "$gem" ]; then
    [ -f "$gem" ] || { echo "error: no gem at '$gem'" >&2; exit 1; }
    cp "$gem" "$directory/"
    hash=$( (sha256sum "$gem" 2>/dev/null || shasum -a 256 "$gem") | cut -c1-8)
    if [ $mode = install ]; then label="$(basename "$gem" .gem | sed 's/^ceedling-//')-$hash"; else label="$version-with-$hash"; fi
fi
image="vscode-ceedling-validate:$label"
docker build -q -t "$image" --build-arg CEEDLING="$base" --build-arg GEM_MODE=$mode --build-arg SIDECAR="$sidecar_image" \
    --build-context "gem=$directory" -f "$repo/sidecar/validate.Dockerfile" "$repo/sidecar" >/dev/null

# The repo and node_modules are read-only. Each run builds its projects in the container's own /ws,
# so nothing is left on the host.
container=(docker run --rm -e CEEDLING_DECORATORS=false -v "$repo":/workspace:ro -v "$node_modules_volume":/workspace/node_modules:ro)
run_suite() {
    echo "=== Ceedling $label: $*"
    "${container[@]}" --entrypoint node "$image" "/workspace/out-test/tests/validation/$1.js" "${@:2}"
}

case $suite in
    all)
        status=0
        for one in "${all[@]}"; do
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
