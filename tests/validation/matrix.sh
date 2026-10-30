#!/usr/bin/env bash
# Runs every validation suite and probe on each Ceedling version, plus stress with two more seeds,
# then prints which passed. Each run's log lands in out-validate/<timestamp>/<version>/. The probes
# run from 1.2.0, since they trace dumpconfig --stdout. Build the tests first; `just validate-matrix`
# does both.
#
# usage: matrix.sh [seconds]
#   [seconds]      each stress and coverage overlap phase, 60 by default
# MATRIX names the versions, 1.0.0 1.1.10 1.2.0 1.2.1 by default. CEEDLING_GEM, the path to a .gem
# file, adds that gem as a version of its own, and its installation to every other version's image.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
seconds=${1:-60}
read -r -a versions <<< "${MATRIX:-1.0.0 1.1.10 1.2.0 1.2.1}"
if [ -n "${CEEDLING_GEM:-}" ]; then versions+=("$CEEDLING_GEM"); fi
out="$repo/out-validate/$(date +%Y%m%d-%H%M%S)"

runs=()
while IFS= read -r run; do runs+=("$run"); done < <("$here/run.sh" "${versions[0]}" list)
runs+=("stress seed 2" "stress seed 3" "probe:fixes" "probe:overlap" "probe:syscalls")

# A gem counts as 1.2.0 or later.
from_1_2_0() { [[ $1 == *.gem ]] || [ "$(printf '%s\n1.2.0\n' "$1" | sort -V | head -1)" = 1.2.0 ]; }

summary=()
for version in "${versions[@]}"; do
    name=$(basename "$version" .gem)
    mkdir -p "$out/$name"
    failed=()
    for run in "${runs[@]}"; do
        read -r -a words <<< "$run"
        case $run in
            probe:*) from_1_2_0 "$version" || continue; args=("${words[0]}") ;;
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
            grep -E 'violations|stopped|^  - ' "$log" | head -6 | sed 's/^/    /' || true
        fi
    done
    if [ ${#failed[@]} -eq 0 ]; then summary+=("$name: all passed"); else summary+=("$name: FAILED $(IFS=,; echo "${failed[*]}")"); fi
done

echo
echo "Logs: $out"
printf '%s\n' "${summary[@]}"
for line in "${summary[@]}"; do [[ $line == *FAILED* ]] && exit 1; done
exit 0
