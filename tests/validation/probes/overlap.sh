#!/bin/sh
# Discovery's commands looping while clean test:all builds run in the same project directory,
# counting the builds that fail. Before 1.2.1, discovery truncates and rewrites the vendored
# framework sources mid-build (#1361), the hazard the engine's locks prevent. The rewritten files
# are identical, so a build fails only if the compiler reads one while it is empty, and trials
# have seen every build pass on 1.2.0 and 1.2.1 alike. A pass here doesn't make the race safe.
set -u
mkdir -p /ws/a && cp -R /workspace/tests/manual/. /ws/a/ && rm -rf /ws/a/build
cd /ws/a
M="--mixin /workspace/assets/mixins/report-tests-log-factory.yml"
ceedling version | grep 'Ceedling =>'
failed=0
for i in 1 2 3 4 5 6; do
    ceedling clobber $M >/dev/null 2>&1
    ( while [ ! -f /tmp/stop ]; do ceedling files:test $M >/dev/null 2>&1; ceedling dumpconfig --stdout $M >/dev/null 2>&1; done ) &
    loop=$!
    ceedling test:all $M > /tmp/build.$i 2>&1
    touch /tmp/stop; wait $loop; rm -f /tmp/stop
    if grep -q -E "error:|EXCEPTION|could not complete" /tmp/build.$i; then
        failed=$((failed + 1)); echo "  build $i: failed"; grep -m3 -E "error:|EXCEPTION" /tmp/build.$i | cut -c1-160
    else
        echo "  build $i: ok"
    fi
done
echo "builds that failed: $failed of 6"
