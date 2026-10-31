#!/bin/sh
# Discovery's commands looping alongside the commands it could overlap without the engine's locks.
#   O1  Clean test:all builds in the same project directory, counting the builds that fail. Before
#       1.2.1, discovery truncates and rewrites the vendored framework sources mid-build (#1361),
#       the hazard the locks prevent. The rewritten files are identical, so a build fails only if
#       the compiler reads one while it is empty, which is rare. A pass doesn't make the race safe.
#   O2  A clobber of a build root padded to 20,000 files, so discovery runs while it deletes. It
#       must leave no file but the vendored sources clobber keeps, and the next build must compile
#       as many files as the first. Discovery may leave the empty directories it recreates, and
#       none of its commands may fail.
# It needs Ceedling 1.2.0 or later, for dumpconfig --stdout.
set -u
rm -f /tmp/stop /tmp/discovery-failures
mkdir -p /ws/a && cp -R /workspace/tests/manual/. /ws/a/ && rm -rf /ws/a/build
cd /ws/a
M="--mixin /workspace/assets/mixins/report-tests-log-factory.yml"
ceedling version | grep 'Ceedling =>'
discovering() {
    while [ ! -f /tmp/stop ]; do
        ceedling files:test $M >/dev/null 2>&1 || echo files:test >> /tmp/discovery-failures
        ceedling dumpconfig --stdout $M >/dev/null 2>&1 || echo dumpconfig >> /tmp/discovery-failures
    done
}
failures() { n=$(cat /tmp/discovery-failures 2>/dev/null | wc -l); rm -f /tmp/discovery-failures; echo $n; }
stop() { touch /tmp/stop; wait "$1"; rm -f /tmp/stop; }

echo "== O1: clean builds during discovery (any version: no build fails, though that proves little)"
failed=0
for i in 1 2 3 4 5 6; do
    ceedling clobber $M >/dev/null 2>&1
    discovering & loop=$!
    ceedling test:all $M > /tmp/build.$i 2>&1
    stop $loop
    if grep -q -E "error:|EXCEPTION|could not complete" /tmp/build.$i; then
        failed=$((failed + 1)); echo "  build $i: failed"; grep -m3 -E "error:|EXCEPTION" /tmp/build.$i | cut -c1-160
    else
        echo "  build $i: ok"
    fi
done
echo "  builds that failed: $failed of 6; discovery commands that failed: $(failures)"

echo "== O2: clobber during discovery (1.2.1 and later: no files left, every file recompiled)"
compiles() { grep -c '^Compiling' "$1"; }
ceedling clobber $M >/dev/null 2>&1; ceedling test:all $M > /tmp/first 2>&1
[ "$(compiles /tmp/first)" -gt 0 ] || echo "  warning: the first build compiled nothing, so the counts below prove nothing"
for i in 1 2 3; do
    for d in $(seq 40); do mkdir -p build/test/out/pad$d && (cd build/test/out/pad$d && seq 500 | xargs touch); done
    discovering & loop=$!
    sleep 0.5; ceedling clobber $M > /tmp/clobber 2>&1
    stop $loop
    left=$(find build -type f -not -path 'build/vendor/*' 2>/dev/null | wc -l)
    ceedling test:all $M > /tmp/next 2>&1
    echo "  clobber $i: exceptions $(grep -c EXCEPTION /tmp/clobber); files left $left; next build compiles $(compiles /tmp/next) of $(compiles /tmp/first); discovery commands that failed: $(failures)"
done
