#!/bin/sh
# Ceedling's own behavior behind three of the engine's choices, from the command line alone:
#   P1  A delta build reruns a changed --test-case filter from 1.2.1 (#1360). Before, it reruns
#       the previous filter's tests, so the engine passes --force-test-rerun with a filter.
#   P2  A delta build skips a test whose coverage counters were deleted, leaving a report with
#       every hit at 0, so every coverage run passes --force-test-rerun after its reset.
#   P3  dumpconfig and files:test rewrite files under build/ before 1.2.1 (#1361), so discovery
#       holds the project's locks.
# Expected output is in each heading; the probe reports, it doesn't judge. P3 needs Ceedling 1.2.0
# or later, for dumpconfig --stdout.
set -u
mkdir -p /ws && cp -R /workspace/tests/validation/workspaces/gated/. /ws/
cd /ws/project
M="--mixin /ws/mixins/gcovr.yml --mixin /workspace/assets/mixins/report-tests-log-factory.yml"
names() { grep -o '<Name>[^<]*</Name>' build/artifacts/test/cppunit_tests_report.xml 2>/dev/null | sed 's/<[^>]*>//g' | tr '\n' ' '; echo; }
counters() { find build/gcov/out -name '*.gcda' 2>/dev/null | wc -l; }
hit() { grep -o 'line number="10" hits="[0-9]*"' build/artifacts/gcov/gcovr/GcovCoverageCobertura.xml 2>/dev/null | head -1; }
reset() { find build/gcov/out \( -name '*.gcda' -o -name '*.gcov' \) -delete; rm -f build/artifacts/gcov/gcovr/*.xml; }
ceedling version | grep 'Ceedling =>'

echo "== P1: alternating --test-case filters, no --force-test-rerun (1.2.1 and later: alpha, beta, both)"
for filter in "--test-case=test_filter_alpha" "--test-case=test_filter_beta" ""; do
    rm -f build/artifacts/test/cppunit_tests_report.xml
    ceedling test:test_filters.c $filter $M >/dev/null 2>&1
    printf '  %-32s -> ' "${filter:-(no filter)}"; names
done

echo "== P2: counters deleted, then gcov: without and with --force-test-rerun (without: no counters or 0 hits)"
ceedling gcov:test_filters.c $M >/dev/null 2>&1; echo "  fresh build:  counters=$(counters) $(hit)"
reset; ceedling gcov:test_filters.c $M >/dev/null 2>&1; echo "  reset:        counters=$(counters) $(hit)"
reset; ceedling gcov:test_filters.c --force-test-rerun $M >/dev/null 2>&1; echo "  reset, forced: counters=$(counters) $(hit)"

echo "== P3: files under build/ that dumpconfig --stdout and files:test change (1.2.1 and later: none)"
snapshot() { find build -type f -exec stat -c '%i %Y %s %n' {} + | sort -k4; }
snapshot > /tmp/before; sleep 1.1
ceedling dumpconfig --stdout $M >/dev/null 2>&1; ceedling files:test $M >/dev/null 2>&1
snapshot > /tmp/after
echo "  build files: $(wc -l < /tmp/before); changed or new: $(diff /tmp/before /tmp/after | grep -c '^>')"
diff /tmp/before /tmp/after | grep '^>' | awk '{print "   ", $5}' | head -12
