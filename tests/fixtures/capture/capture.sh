#!/usr/bin/env bash
# Runs test files through a real Ceedling release in Docker and saves what Ceedling produced.
# The project is tests/fixtures/capture/project.yml plus the extension's bundled report mixin, so
# the CppUnit report is the one the extension itself reads.
#
# usage: capture.sh <ceedling-version> <out-dir> <file>...
#   <ceedling-version>  a throwtheswitch/madsciencelab-plugins image tag, e.g. 1.2.0
#   <out-dir>           receives stdout.txt, stderr.txt, and cppunit_tests_report.xml
#   <file>...           test files go to test/; .c/.h sources work too (see :paths below)
set -euo pipefail
version=$1; out=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/ceedling-capture.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$here/project.yml" "$work/"
mkdir -p "$work/test" "$out"
for file in "$@"; do cp "$file" "$work/test/"; done
status=0
docker run --rm -e CEEDLING_DECORATORS=false -v "$work":/project -v "$repo/assets/mixins":/mixins -w /project \
    "throwtheswitch/madsciencelab-plugins:$version" \
    ceedling test:all --mixin /mixins/report-tests-log-factory.yml >"$out/stdout.txt" 2>"$out/stderr.txt" || status=$?
echo "ceedling exit status: $status"
cp "$work/build/artifacts/test/cppunit_tests_report.xml" "$out/" 2>/dev/null || echo "no CppUnit report was produced"
