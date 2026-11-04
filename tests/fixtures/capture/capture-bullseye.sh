#!/usr/bin/env bash
# Runs Ceedling's Bullseye plugin against bullseye-probe/ in a real Ceedling release in Docker, and
# saves the reports, resolved configurations, and console output the extension's design rests on.
# Bullseye is commercial and can't live in an image, so each run installs it into a throwaway
# container from your installer and license key, and nothing of it outlives the container. Every
# file it writes has license numbers and the key redacted. Only its reports and dumpconfigs are
# committed, as fixtures.
#
# usage: BULLSEYE_LICENSE_KEY=... capture-bullseye.sh <ceedling-version> <installer-dir> <out-dir>
#   <ceedling-version>  a throwtheswitch/madsciencelab-plugins image tag, 1.2.0 or later, the first
#                       releases whose Bullseye plugin loads
#   <installer-dir>     an unpacked Bullseye Coverage installer for Linux x64, holding `install`
#   <out-dir>           receives versions.txt, dumpconfig-bullseye-*.yml, *.xml reports, and one
#                       steps/<name>.txt per experiment: its command, exit status, and output
set -euo pipefail
version=$1; installer=$(cd "$2" && pwd); out=$(mkdir -p "$3" && cd "$3" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
: "${BULLSEYE_LICENSE_KEY:?set BULLSEYE_LICENSE_KEY to your Bullseye license key}"
[ -x "$installer/install" ] || { echo "error: $installer has no install script" >&2; exit 1; }
docker run --rm -i -e BULLSEYE_LICENSE_KEY -e CEEDLING_DECORATORS=false \
    -v "$installer":/opt/bullseye-installer:ro -v "$here/bullseye-probe":/probe:ro -v "$out":/out \
    -v "$here/../../../assets/mixins":/bundled:ro \
    --entrypoint bash "throwtheswitch/madsciencelab-plugins:$version" <<'SCRIPT'
set -uo pipefail
# The key leaves the environment once Bullseye is installed, so no Ceedling or Bullseye process sees
# it. redact() alone keeps a copy, passed through awk's environment, which, unlike -v, takes it as is.
key=$BULLSEYE_LICENSE_KEY
unset BULLSEYE_LICENSE_KEY
# The key and license numbers never reach /out.
redact() {
    KEY=$key awk '{
        key = ENVIRON["KEY"]
        while (key != "" && (i = index($0, key)) > 0) $0 = substr($0, 1, i - 1) "<key>" substr($0, i + length(key))
        gsub(/License [0-9]+/, "License NNNNNN"); print
    }'
}
mkdir -p /out/steps
# step NAME COMMAND...: runs the command in the probe project, recording it, its status, and its output.
step() {
    local name=$1; shift
    { echo "\$ $*"; "$@" 2>&1; echo "[exit $?]"; } | redact > "/out/steps/$name.txt"
}
# keep NAME [REPORT]: saves the Bullseye XML report the last build wrote, if any. A native report
# names the license in its header.
keep() {
    local report=${2:-build/artifacts/bullseye/coverage.xml}
    if [ -f "$report" ]; then redact < "$report" > "/out/$1.xml"
    else echo "no $report" > "/out/$1.missing"; fi
}

# The installer's progress bar is one long line of no interest.
/opt/bullseye-installer/install --prefix /tmp/bullseye --key "$key" --search "/usr/bin:/usr/local/bin" 2>&1 | grep -v '0% \.\.\.' | redact > /out/install.txt
export PATH=/tmp/bullseye/bin:$PATH
cp -r /probe /tmp/probe && cd /tmp/probe/project
{ ceedling version; covc --version 2>&1 | head -3; ls /tmp/bullseye/bin; } 2>&1 | redact > /out/versions.txt
for tool in covclear covxml covselect; do step "help-$tool" "$tool" --help; done

# dumpconfig --stdout arrived in Ceedling 1.2.0, as did the plugin.
for mixin in none cobertura native task license-manager env-path both-plugins; do
    name=$([ $mixin = none ] && echo default || echo $mixin)
    flags=$([ $mixin = none ] || echo "--mixin ../mixins/$mixin.yml")
    # shellcheck disable=SC2086 # no flags, or a flag and its value
    ceedling dumpconfig --stdout $flags 2> /tmp/dumpconfig-stderr.txt | redact > /out/dumpconfig-bullseye-$name.yml
    redact < /tmp/dumpconfig-stderr.txt > /out/steps/dumpconfig-$name-stderr.txt
done

C="--mixin ../mixins/cobertura.yml"
# Paths are project-relative from 1.2.1. 1.2.0 takes a bare name.
step task-by-path ceedling bullseye:test/test_calculator.c $C
step task-by-name ceedling bullseye:test_calculator.c $C
step listing-after-build find build/artifacts test.cov -maxdepth 3
keep cobertura-calculator
# The extension's bundled mixin enables the CppUnit report, which each build context writes apart.
step cppunit ceedling bullseye:test_calculator.c $C --mixin /bundled/report-tests-log-factory.yml --force-test-rerun
step listing-cppunit find build/artifacts -name '*.xml' -not -path '*/covhtml/*'
step covclear-environment sh -c 'env -i PATH=/tmp/bullseye/bin COVFILE=elsewhere.cov covclear -q --file test.cov; echo "[covclear exit $?]"' 
step calculator-again ceedling bullseye:test_calculator.c $C --force-test-rerun
keep cobertura-calculator-twice
step clamp ceedling bullseye:test_clamp.c $C
keep cobertura-cumulative

# covclear keeps the instrumentation, so a delta build measures again without recompiling.
cp test.cov /tmp/before-clear.cov
step covclear-quiet-file covclear -q --file test.cov
step covxml-after-clear covxml -q --cobertura -o /tmp/after-clear.xml
keep cobertura-after-clear /tmp/after-clear.xml
step covclear-env-only env COVFILE=test.cov covclear -q
step covclear-missing-file covclear -q --file /tmp/nowhere.cov
step covclear-no-file-option sh -c 'unset COVFILE; covclear -q'
step rerun-after-clear ceedling bullseye:test_calculator.c $C --force-test-rerun
keep cobertura-after-clear-rerun

# A --test-case run, then the whole file, against the whole file alone.
covclear -q --file test.cov
step filtered ceedling bullseye:test_calculator.c $C --force-test-rerun --test-case=test_add
keep cobertura-filtered
step whole-after-filtered ceedling bullseye:test_calculator.c $C --force-test-rerun
keep cobertura-filtered-then-whole
covclear -q --file test.cov
step whole-alone ceedling bullseye:test_calculator.c $C --force-test-rerun
keep cobertura-whole

step native ceedling bullseye:test_calculator.c --mixin ../mixins/native.yml --force-test-rerun
keep native

# Deferred reports, with a filter, on an existing build and then a fresh one.
step task-deferred ceedling bullseye:test_calculator.c report:bullseye --mixin ../mixins/task.yml --force-test-rerun --test-case=test_both
keep cobertura-task
step clobber-for-task ceedling clobber
step task-fresh ceedling bullseye:test_calculator.c report:bullseye --mixin ../mixins/task.yml
keep cobertura-task-fresh
step listing-task-fresh find build/artifacts -maxdepth 3

# A missing coverage file with every object up to date.
rm -f test.cov
step missing-covfile ceedling bullseye:test_calculator.c $C --force-test-rerun
keep cobertura-missing-covfile
step listing-missing-covfile ls -la test.cov

# Two project configurations in one directory, with build roots apart, share test.cov.
step clobber-for-shared ceedling clobber
step shared-first ceedling bullseye:test_calculator.c $C
step shared-second ceedling bullseye:test_clamp.c --mixin ../mixins/other-root.yml
keep cobertura-shared-second build2/artifacts/bullseye/coverage.xml

# gcov beside Bullseye leaves test.cov alone.
stat -c %Y test.cov > /tmp/covfile-mtime
step both-plugins-gcov ceedling gcov:test_calculator.c --mixin ../mixins/both-plugins.yml
step both-plugins-covfile sh -c "stat -c %Y test.cov; cat /tmp/covfile-mtime"

step license ceedling bullseye:license
step clean ceedling clean
step listing-after-clean ls -la test.cov build/bullseye
# Without Bullseye on PATH, the plugin stops at setup.
step no-bullseye env PATH=/usr/local/bin:/usr/bin:/bin ceedling bullseye:test_calculator.c $C
SCRIPT
echo "captured into $out"
