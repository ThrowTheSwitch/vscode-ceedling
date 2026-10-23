// Runs Ceedling as a child process. CeedlingRunner owns every live process, so a cancelled run
// stops only its own process and disposal stops them all. It has no `vscode` dependency. Tests
// substitute `exec` and `kill` to observe command lines without a Ceedling install.

import child_process from 'child_process';
import fs from 'fs';
import stripAnsi from 'strip-ansi';
import treeKill from 'tree-kill';

export type CeedlingResult = {
    error: child_process.ExecException | null,
    stdout: string,
    stderr: string,
    // True when the run's cancellation fired. The process was killed, so its output is partial.
    cancelled: boolean,
};

// The part of vscode.CancellationToken this module uses. A vscode token satisfies it as is.
export interface Cancellation {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export type CeedlingInvocation = {
    // The program and any leading words, e.g. `ceedling` or `bundle exec ceedling`. Used verbatim.
    command: string,
    args: readonly string[],
    cwd: string,
    // undefined selects the platform's default shell.
    shell: string | undefined,
    stripAnsi: boolean,
    cancellation?: Cancellation,
};

// Node's 1 MiB default kills a large `test:all` mid-run, debug verbosity especially.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Double-quotes a token containing whitespace, so a path with spaces survives as one shell word.
// Windows install paths and temp directories routinely contain spaces. Double quotes mean the
// same in cmd.exe, PowerShell, and POSIX shells for such plain paths.
export function quoteIfNeeded(token: string): string {
    return /\s/.test(token) && !/^".*"$/.test(token) ? `"${token}"` : token;
}

export function buildCommandLine(command: string, args: readonly string[]): string {
    return [command, ...args.map(quoteIfNeeded)].join(' ');
}

// The environment every Ceedling run gets on top of the extension host's own.
// CEEDLING_DECORATORS=false makes Ceedling print plain ASCII instead of emoji decorators, which
// vary across versions. RUBYOPT's -EUTF-8 sets Ruby's default external encoding to UTF-8 under
// any locale. Ceedling 1.0.0 otherwise crashes on non-ASCII source when the locale isn't UTF-8,
// with `EXCEPTION: "\xC3" on US-ASCII`. Forcing LC_ALL instead fails where the forced locale
// doesn't exist, as C.UTF-8 doesn't on macOS. The user's locale and any existing RUBYOPT stay.
export function ceedlingEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const rubyopt = base.RUBYOPT ? `${base.RUBYOPT} -EUTF-8` : '-EUTF-8';
    return { ...base, CEEDLING_DECORATORS: 'false', RUBYOPT: rubyopt };
}

export class CeedlingRunner {
    private readonly live = new Set<child_process.ChildProcess>();
    private readonly exec: typeof child_process.exec;
    private readonly kill: (pid: number) => void;
    private readonly baseEnv: NodeJS.ProcessEnv;

    constructor(deps: { exec?: typeof child_process.exec, kill?: (pid: number) => void, env?: NodeJS.ProcessEnv } = {}) {
        this.exec = deps.exec ?? child_process.exec;
        this.kill = deps.kill ?? killProcessTree;
        this.baseEnv = deps.env ?? process.env;
    }

    run(invocation: CeedlingInvocation): Promise<CeedlingResult> {
        const { cancellation } = invocation;
        if (cancellation?.isCancellationRequested) {
            return Promise.resolve({ error: null, stdout: '', stderr: '', cancelled: true });
        }
        return new Promise((resolve) => {
            // Shared with the exit callback, which a test double may call before exec even returns.
            // The child is tracked as live only if it is still running once exec returns.
            const state: { tracked?: child_process.ChildProcess, subscription?: { dispose(): void }, finished: boolean, cancelled: boolean } =
                { finished: false, cancelled: false };
            const child = this.exec(
                buildCommandLine(invocation.command, invocation.args),
                {
                    cwd: invocation.cwd,
                    shell: invocation.shell,
                    env: ceedlingEnvironment(this.baseEnv),
                    maxBuffer: MAX_OUTPUT_BYTES,
                },
                (error, stdout, stderr) => {
                    state.finished = true;
                    if (state.tracked) this.live.delete(state.tracked);
                    state.subscription?.dispose();
                    resolve({
                        error,
                        stdout: invocation.stripAnsi ? stripAnsi(stdout) : stdout,
                        stderr: invocation.stripAnsi ? stripAnsi(stderr) : stderr,
                        cancelled: state.cancelled,
                    });
                },
            );
            if (!state.finished) {
                state.tracked = child;
                this.live.add(child);
                state.subscription = cancellation?.onCancellationRequested(() => {
                    state.cancelled = true;
                    this.stop(child);
                });
            }
        });
    }

    // Stops every live process, e.g. when the extension is disposed.
    cancelAll(): void {
        for (const child of this.live) {
            this.stop(child);
        }
    }

    // Kills the whole process tree. Ceedling spawns compilers and test executables of its own.
    private stop(child: child_process.ChildProcess): void {
        if (child.pid !== undefined) {
            this.kill(child.pid);
        }
    }
}

// The one tree-kill call made, without its overloads, so a test double is easy to write.
type TreeKill = (pid: number, signal: string, callback: (error?: Error) => void) => void;

// Kills a process and every process beneath it. Linux reads the tree from /proc. tree-kill would
// spawn `ps` there, which minimal containers lack, and its unhandled spawn error would crash the
// extension host. Elsewhere tree-kill uses taskkill (Windows) or pgrep (macOS), both always
// present. A failure falls back to killing the root process alone. Tests substitute `platform`
// and `treeKill` to reach that fallback.
export function killProcessTree(pid: number, deps: { platform?: NodeJS.Platform, treeKill?: TreeKill } = {}): void {
    if ((deps.platform ?? process.platform) === 'linux') {
        for (const target of descendantsOf(pid, linuxProcessParents())) {
            try {
                process.kill(target, 'SIGTERM');
            } catch {
                // Already exited.
            }
        }
        return;
    }
    (deps.treeKill ?? treeKill)(pid, 'SIGTERM', (error) => {
        if (error) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // Already exited.
            }
        }
    });
}

// The root and all its descendants, given each process's parent.
export function descendantsOf(root: number, parents: ReadonlyMap<number, number>): number[] {
    const children = new Map<number, number[]>();
    for (const [pid, parent] of parents) {
        children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const found: number[] = [];
    const pending = [root];
    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
        found.push(pid);
        pending.push(...(children.get(pid) ?? []));
    }
    return found;
}

// The parent pid from a /proc/<pid>/stat line, `pid (comm) state ppid ...`. The command name may
// itself contain spaces and parentheses, so fields are read after its last closing parenthesis.
export function parseProcStatParent(stat: string): number | undefined {
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const parent = parseInt(fields[1] ?? '', 10);
    return stat.includes(')') && Number.isFinite(parent) ? parent : undefined;
}

function linuxProcessParents(): Map<number, number> {
    const parents = new Map<number, number>();
    // Synchronous on purpose: a consistent snapshot of the tree before any kill. /proc is in memory,
    // and this runs only on cancellation.
    // eslint-disable-next-line no-restricted-properties -- a consistent snapshot, see above
    for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            // eslint-disable-next-line no-restricted-properties -- see above
            const parent = parseProcStatParent(fs.readFileSync(`/proc/${entry}/stat`, 'utf8'));
            if (parent !== undefined) parents.set(Number(entry), parent);
        } catch {
            // The process exited while the tree was being read.
        }
    }
    return parents;
}
