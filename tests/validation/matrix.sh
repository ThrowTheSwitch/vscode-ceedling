#!/usr/bin/env bash
# Runs every validation suite and probe on each Ceedling version, plus stress with two more seeds,
# then prints each version's failed suites. The probes judge nothing, so their output is only in
# the logs. Each run's log lands in out-validate/<timestamp>/<name>/, where a gem's name is its
# file's. The probes run from 1.2.0, since they use dumpconfig --stdout. Build the tests first;
# `just validate-matrix` does both.
#
# usage: matrix.sh [seconds]
#   [seconds]      each stress and coverage overlap phase, 60 by default
# MATRIX names the versions, 1.0.0 1.1.10 1.2.0 1.2.1 by default. CEEDLING_GEM, the absolute path to
# a .gem file, adds that gem as a version of its own, and its installation to every other version's
# image.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
seconds=${1:-60}
read -r -a versions <<< "${MATRIX:-1.0.0 1.1.10 1.2.0 1.2.1}"
if [ -n "${CEEDLING_GEM:-}" ]; then versions+=("$CEEDLING_GEM"); fi
[ ${#versions[@]} -gt 0 ] || { echo "error: MATRIX names no versions" >&2; exit 1; }
out="$repo/out-validate/$(date +%Y%m%d-%H%M%S)"

runs=()
while IFS= read -r run; do runs+=("$run"); done < <("$here/run.sh" "${versions[0]}" list)
runs+=("stress seed 2" "stress seed 3" "probe:fixes" "probe:overlap" "probe:syscalls")

# A gem counts as 1.2.0 or later. Older macOS sort has no -V, so this compares the numbers itself.
from_1_2_0() {
    [[ $1 == *.gem ]] && return 0
    local major minor
    IFS=. read -r major minor _ <<< "$1"
    [ "$major" -gt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -ge 2 ]; }
}

summary=()
for version in "${versions[@]}"; do
    name=$(basename "$version" .gem)
    mkdir -p "$out/$name"
    failed=()
    for run in "${runs[@]}"; do
        read -r -a words <<< "$run"
        case $run in
            probe:*) from_1_2_0 "$version" || continue; args=("${words[0]}") ;;
            # The seed is stress's third number, after 6, its default operations at once.
            "stress seed "*) args=(stress "$seconds" 6 "${words[2]}") ;;
            stress* | coverage*) args=("${words[@]}" "$seconds") ;;
            *) args=("${words[@]}") ;;
        esac
        log="$out/$name/${run// /_}.log"
        echo "=== $name: $run"
        if "$here/run.sh" "$version" "${args[@]}" > "$log" 2>&1; then
            grep -E 'violations|skipped' "$log" | sed 's/^/    /' || true
        else
            failed+=("$run")
            # A run that stopped before any suite, e.g. in its image build, shows its last lines.
            grep -E 'violations|stopped|^  - ' "$log" | head -6 | sed 's/^/    /' | grep . || tail -3 "$log" | sed 's/^/    /'
        fi
    done
    if [ ${#failed[@]} -eq 0 ]; then summary+=("$name: every suite passed"); else summary+=("$name: FAILED $(IFS=,; echo "${failed[*]}")"); fi
done

echo
echo "Logs, with the probes' output: $out"
printf '%s\n' "${summary[@]}"
for line in "${summary[@]}"; do [[ $line == *FAILED* ]] && exit 1; done
exit 0
