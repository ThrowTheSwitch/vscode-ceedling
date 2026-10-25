#!/bin/sh
# Every filesystem call discovery's commands make under a build root that a full test and coverage
# build has populated, and every write they make outside /dev, /proc, and /tmp. Calls that fail
# with ENOENT or EEXIST change nothing, so they don't count. From 1.2.1 there should be none, which
# is what lets discovery run without the project's locks (docs/Architecture.md, "Discovery without
# the locks from 1.2.1"). run.sh runs this probe as root, since strace needs ptrace. It needs
# Ceedling 1.2.0 or later, for dumpconfig --stdout.
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
    WRITES='O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|mkdir|rename|unlink|rmdir|utimensat|truncate|chmod|symlink|link(at)?\('
    writes=$(grep -E "$WRITES" /tmp/hits | grep -v -E 'ENOENT|EEXIST')
    reads=$(grep -E 'O_RDONLY' /tmp/hits | grep -v ENOENT)
    elsewhere=$(grep -v '/ws/project/build\|"build' /tmp/trace | grep -E "$WRITES" | grep -v -E 'ENOENT|EEXIST|"/(dev|proc|tmp)/')
    echo "== ceedling $command: $(wc -l < /tmp/hits) calls touch build/; writes: $(printf '%s' "$writes" | grep -c .); file reads: $(printf '%s' "$reads" | grep -c .); writes elsewhere: $(printf '%s' "$elsewhere" | grep -c .)"
    printf '%s\n' "$elsewhere" | grep . | sed 's/^[0-9]* */    E /' | cut -c1-150 | head -4
    printf '%s\n' "$writes" | grep . | sed 's/^[0-9]* */    W /' | cut -c1-150 | head -8
    printf '%s\n' "$reads" | grep . | sed 's/^[0-9]* */    R /' | cut -c1-150 | head -8
    grep -v -E 'O_RDONLY|O_WRONLY|O_RDWR' /tmp/hits | sed -E 's/^[0-9]+ +([a-z0-9_]+)\(.*"([^"]*build[^"]*)".*\) = (.*)$/    \1 \2 = \3/' | sort | uniq -c | sort -rn | head -6
done
