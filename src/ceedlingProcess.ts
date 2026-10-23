// Runs Ceedling as a child process. CeedlingRunner owns every live process, so a cancelled run
// stops only its own process and disposal stops them all. It has no `vscode` dependency. Tests
// substitute `exec` and `kill` to observe command lines without a Ceedling install.

import child_process from 'child_process';
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
        this.kill = deps.kill ?? ((pid) => treeKill(pid));
        this.baseEnv = deps.env ?? process.env;
    }

    run(invocation: CeedlingInvocation): Promise<CeedlingResult> {
        const { cancellation } = invocation;
        if (cancellation?.isCancellationRequested) {
            return Promise.resolve({ error: null, stdout: '', stderr: '', cancelled: true });
        }
        return new Promise((resolve) => {
            // Declared ahead of exec: a test double may call back before exec returns.
            let child: child_process.ChildProcess | undefined;
            let subscription: { dispose(): void } | undefined;
            let finished = false;
            let cancelled = false;
            child = this.exec(
                buildCommandLine(invocation.command, invocation.args),
                {
                    cwd: invocation.cwd,
                    shell: invocation.shell,
                    env: ceedlingEnvironment(this.baseEnv),
                    maxBuffer: MAX_OUTPUT_BYTES,
                },
                (error, stdout, stderr) => {
                    finished = true;
                    if (child) this.live.delete(child);
                    subscription?.dispose();
                    resolve({
                        error,
                        stdout: invocation.stripAnsi ? stripAnsi(stdout) : stdout,
                        stderr: invocation.stripAnsi ? stripAnsi(stderr) : stderr,
                        cancelled,
                    });
                },
            );
            if (!finished) {
                this.live.add(child);
                subscription = cancellation?.onCancellationRequested(() => {
                    cancelled = true;
                    this.stop(child!);
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
