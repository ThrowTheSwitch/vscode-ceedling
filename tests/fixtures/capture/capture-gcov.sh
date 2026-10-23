#!/usr/bin/env bash
# Runs Ceedling's gcov plugin against gcov-probe/ in a real Ceedling release in Docker, and saves
# the coverage reports and resolved configurations the extension reads. The probe has one source
# inside the Ceedling project and one above it, so reports show both kinds of path.
#
# usage: capture-gcov.sh <ceedling-version> <out-dir>
#   <ceedling-version>  a throwtheswitch/madsciencelab-plugins image tag, e.g. 1.2.0. The image
#                       supplies gcov, gcovr, and ReportGenerator.
#   <out-dir>           receives dumpconfig-gcov-*.yml, gcovr/ and ReportGenerator/ reports for one
#                       Cobertura report type (single/) and for several (multi/), and versions.txt
set -euo pipefail
version=$1; out=$(mkdir -p "$2" && cd "$2" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
docker run --rm -i -e CEEDLING_DECORATORS=false -v "$here/gcov-probe":/probe:ro -v "$out":/out \
    --entrypoint sh "throwtheswitch/madsciencelab-plugins:$version" <<'SCRIPT'
set -eu
# ReportGenerator is a .NET global tool, outside the PATH a bare `sh` starts with.
export PATH=$PATH:/home/dev/.dotnet/tools
cp -r /probe /tmp/probe && cd /tmp/probe/project
{ gcovr --version | head -1; echo "ReportGenerator $(ls /home/dev/.dotnet/tools/.store/dotnet-reportgenerator-globaltool/)"; } > /out/versions.txt
# dumpconfig --stdout arrived in Ceedling 1.2.0. Earlier releases write only to a file.
dump() { ceedling dumpconfig /tmp/dump.yml "$@" >/dev/null && cp /tmp/dump.yml "$out_file"; }
out_file=/out/dumpconfig-gcov-default.yml dump
out_file=/out/dumpconfig-gcov-both-utilities.yml dump --mixin ../mixins/both.yml
out_file=/out/dumpconfig-gcov-cobertura-filename.yml dump --mixin ../mixins/filename.yml
out_file=/out/dumpconfig-gcov-report-task.yml dump --mixin ../mixins/task.yml
for variant in single:both multi:multi; do
    rm -rf build
    ceedling gcov:all --mixin "../mixins/${variant#*:}.yml" > /out/gcov-${variant%%:*}-stdout.txt 2>&1
    mkdir -p "/out/${variant%%:*}" && cp -r build/artifacts/gcov/gcovr build/artifacts/gcov/ReportGenerator "/out/${variant%%:*}/"
done
SCRIPT
echo "captured into $out"
