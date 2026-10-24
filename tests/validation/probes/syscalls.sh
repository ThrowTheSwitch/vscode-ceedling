#!/bin/sh
# Every filesystem call discovery's commands make under a build root that a full test and coverage
# build has populated. From 1.2.1 there should be no writes, which is what would let discovery
# run without the project's locks (docs/Architecture.md, "Possible speedup"). run.sh runs this
# probe as root, since strace needs ptrace. It needs Ceedling 1.2.0 or later, for dumpconfig --stdout.
set -u
mkdir -p /ws && cp -R /workspace/tests/validation/workspaces/gated/. /ws/
cd /ws/project
M="--project project.yml --mixin /ws/mixins/gcovr.yml --mixin /workspace/assets/mixins/report-tests-log-factory.yml"
ceedling version | grep 'Ceedling =>'
ceedling test:all $M >/dev/null 2>&1; ceedling gcov:all $M >/dev/null 2>&1
echo "build files: $(find build -type f | wc -l), directories: $(find build -type d | wc -l)"
CALLS=open,openat,creat,mkdir,mkdirat,rename,renameat,renameat2,unlink,unlinkat,rmdir,utimensat,truncate,ftruncate,chmod,fchmodat,symlink,symlinkat,link,linkat,stat,newfstatat,statx,access,faccessat,faccessat2,getdents64,chdir
for command in "dumpconfig --stdout" "files:test"; do
    strace -f -qq -o /tmp/trace -e trace=$CALLS ceedling $command $M >/dev/null 2>&1
    grep '/ws/project/build\|"build' /tmp/trace > /tmp/hits
    writes=$(grep -E 'O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|mkdir|rename|unlink|rmdir|utimensat|truncate|chmod|symlink|link\(' /tmp/hits | grep -v ENOENT)
    reads=$(grep -E 'O_RDONLY' /tmp/hits | grep -v ENOENT)
    echo "== ceedling $command: $(wc -l < /tmp/hits) calls touch build/; writes: $(printf '%s' "$writes" | grep -c .); file reads: $(printf '%s' "$reads" | grep -c .)"
    printf '%s\n' "$writes" | grep . | sed 's/^[0-9]* */    W /' | cut -c1-150 | head -8
    printf '%s\n' "$reads" | grep . | sed 's/^[0-9]* */    R /' | cut -c1-150 | head -8
    grep -v -E 'O_RDONLY|O_WRONLY|O_RDWR' /tmp/hits | sed -E 's/^[0-9]+ +([a-z0-9_]+)\(.*"([^"]*build[^"]*)".*\) = (.*)$/    \1 \2 = \3/' | sort | uniq -c | sort -rn | head -6
done
