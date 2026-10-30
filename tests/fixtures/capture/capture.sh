#!/usr/bin/env bash
# Runs test files through a real Ceedling release in Docker and saves what Ceedling produced.
# The project is tests/fixtures/capture/project.yml plus the extension's bundled report mixin, so
# the CppUnit report is the one the extension itself reads.
#
# usage: capture.sh <ceedling-version | ceedling.gem> <out-dir> <file>...
#   <ceedling-version>  a throwtheswitch/madsciencelab-plugins image tag, e.g. 1.2.0
#   <ceedling.gem>      the absolute path to a Ceedling .gem file, installed over 1.2.1's image
#   <out-dir>           receives stdout.txt, stderr.txt, and cppunit_tests_report.xml
#   <file>...           test files go to test/; .c/.h sources work too (see :paths below)
# CAPTURE_TASK replaces `test:all`, e.g. `files:test`. CAPTURE_MIXIN, a mixin file's path, applies
# it too. CAPTURE_VENDOR=1 copies the running Ceedling into vendor/ceedling, so Ceedling hands off
# to it, as to any other installation.
set -euo pipefail
version=$1; out=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/ceedling-capture.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$here/project.yml" "$work/"
mkdir -p "$work/test" "$work/gem" "$out"
for file in "$@"; do cp "$file" "$work/test/"; done
mixins=(--mixin /mixins/report-tests-log-factory.yml)
if [ -n "${CAPTURE_MIXIN:-}" ]; then cp "$CAPTURE_MIXIN" "$work/extra.yml"; mixins+=(--mixin /project/extra.yml); fi
# A gem installs as root over 1.2.1's Ceedling, which it then replaces.
image="throwtheswitch/madsciencelab-plugins:$version" setup=":"
if [[ $version == *.gem ]]; then
    cp "$version" "$work/gem/"
    image="throwtheswitch/madsciencelab-plugins:1.2.1"
    setup="gem install --local --no-document /project/gem/*.gem >/dev/null && gem uninstall -x ceedling -v 1.2.1 >/dev/null"
fi
if [ "${CAPTURE_VENDOR:-}" = 1 ]; then
    setup="$setup && mkdir -p vendor && cp -R \"\$(ruby -e 'print Gem::Specification.find_by_name(%q(ceedling)).gem_dir')\" vendor/ceedling"
fi
status=0
docker run --rm --user root -e CEEDLING_DECORATORS=false -v "$work":/project -v "$repo/assets/mixins":/mixins -w /project --entrypoint sh "$image" \
    -c "$setup && ceedling ${CAPTURE_TASK:-test:all} ${mixins[*]}" >"$out/stdout.txt" 2>"$out/stderr.txt" || status=$?
echo "ceedling exit status: $status"
cp "$work/build/artifacts/test/cppunit_tests_report.xml" "$out/" 2>/dev/null || echo "no CppUnit report was produced"
