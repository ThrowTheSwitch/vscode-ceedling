import * as assert from 'assert';
import * as child_process from 'child_process';
import { buildCommandLine, Cancellation, CeedlingInvocation, CeedlingRunner, ceedlingEnvironment, descendantsOf, parseProcStatParent, quoteIfNeeded } from '../../src/ceedlingProcess';

type ExecCall = { command: string, options: child_process.ExecOptions, finish: (error: Error | null, stdout: string, stderr: string) => void };

// An exec double that records each call and leaves it running until the test calls `finish`.
function deferredExec(calls: ExecCall[], pid = 4242): typeof child_process.exec {
    return ((command: string, options: child_process.ExecOptions, callback: any) => {
        calls.push({ command, options, finish: (error, stdout, stderr) => callback(error, stdout, stderr) });
        return { pid } as child_process.ChildProcess;
    }) as unknown as typeof child_process.exec;
}

// A manually fired cancellation, shaped like vscode.CancellationToken.
function cancellation(): Cancellation & { fire(): void, listeners: number } {
    const listeners = new Set<() => void>();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        fire() {
            token.isCancellationRequested = true;
            for (const listener of [...listeners]) listener();
        },
        get listeners() { return listeners.size; },
    };
    return token;
}

function invocation(overrides: Partial<CeedlingInvocation> = {}): CeedlingInvocation {
    return { command: 'ceedling', args: ['test:all'], cwd: '/ws/proj', shell: undefined, stripAnsi: true, ...overrides };
}

suite('quoteIfNeeded / buildCommandLine', () => {
    test('a token with whitespace is double-quoted; others pass through', () => {
        assert.strictEqual(quoteIfNeeded('/Program Files/ext/bundled.yml'), '"/Program Files/ext/bundled.yml"');
        assert.strictEqual(quoteIfNeeded('test:test_foo.c'), 'test:test_foo.c');
    });

    test('an already double-quoted token is left alone', () => {
        assert.strictEqual(quoteIfNeeded('"a b"'), '"a b"');
    });

    test('the command is used verbatim and every argument is quoted as needed', () => {
        assert.strictEqual(
            buildCommandLine('bundle exec ceedling', ['test:my test.c', '--mixin', '/tmp/x.yml']),
            'bundle exec ceedling "test:my test.c" --mixin /tmp/x.yml',
        );
    });
});

suite('ceedlingEnvironment', () => {
    test('disables decorators and forces Ruby to UTF-8 without touching the locale', () => {
        const env = ceedlingEnvironment({ LANG: 'C', PATH: '/bin' });
        assert.strictEqual(env.CEEDLING_DECORATORS, 'false');
        assert.strictEqual(env.RUBYOPT, '-EUTF-8');
        assert.strictEqual(env.LANG, 'C');
        assert.strictEqual(env.LC_ALL, undefined);
        assert.strictEqual(env.PATH, '/bin');
    });

    test('appends to an existing RUBYOPT', () => {
        assert.strictEqual(ceedlingEnvironment({ RUBYOPT: '-W0' }).RUBYOPT, '-W0 -EUTF-8');
    });
});

suite('CeedlingRunner', () => {
    test('runs the built command line in the given directory, shell, and environment', async () => {
        const calls: ExecCall[] = [];
        const runner = new CeedlingRunner({ exec: deferredExec(calls), env: { PATH: '/bin' } });
        const pending = runner.run(invocation({ args: ['test:a b.c'], shell: '/bin/zsh' }));
        assert.strictEqual(calls[0].command, 'ceedling "test:a b.c"');
        assert.strictEqual(calls[0].options.cwd, '/ws/proj');
        assert.strictEqual(calls[0].options.shell, '/bin/zsh');
        assert.strictEqual((calls[0].options.env as NodeJS.ProcessEnv).RUBYOPT, '-EUTF-8');
        assert.ok((calls[0].options.maxBuffer ?? 0) >= 64 * 1024 * 1024);
        calls[0].finish(null, 'out', 'err');
        assert.deepStrictEqual(await pending, { error: null, stdout: 'out', stderr: 'err', cancelled: false });
    });

    test('strips ANSI escape sequences only when asked to', async () => {
        const calls: ExecCall[] = [];
        const runner = new CeedlingRunner({ exec: deferredExec(calls) });
        const stripped = runner.run(invocation({ stripAnsi: true }));
        calls[0].finish(null, '\u001b[32mOK\u001b[0m', '');
        assert.strictEqual((await stripped).stdout, 'OK');
        const raw = runner.run(invocation({ stripAnsi: false }));
        calls[1].finish(null, '\u001b[32mOK\u001b[0m', '');
        assert.strictEqual((await raw).stdout, '\u001b[32mOK\u001b[0m');
    });

    test('cancellation kills only its own process tree and marks the result cancelled', async () => {
        const calls: ExecCall[] = [];
        const killed: number[] = [];
        let pid = 100;
        const exec = ((command: string, options: any, callback: any) => {
            calls.push({ command, options, finish: (e, o, s) => callback(e, o, s) });
            return { pid: pid++ } as child_process.ChildProcess;
        }) as unknown as typeof child_process.exec;
        const runner = new CeedlingRunner({ exec, kill: (p) => killed.push(p) });
        const token = cancellation();
        const first = runner.run(invocation({ cancellation: token }));
        const second = runner.run(invocation());
        token.fire();
        assert.deepStrictEqual(killed, [100]);
        calls[0].finish(new Error('killed'), 'partial', '');
        calls[1].finish(null, '', '');
        assert.strictEqual((await first).cancelled, true);
        assert.strictEqual((await second).cancelled, false);
        assert.strictEqual(token.listeners, 0, 'the cancellation listener is released when the process ends');
    });

    test('an already-cancelled run never starts', async () => {
        const calls: ExecCall[] = [];
        const runner = new CeedlingRunner({ exec: deferredExec(calls) });
        const token = cancellation();
        token.fire();
        const result = await runner.run(invocation({ cancellation: token }));
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(result.cancelled, true);
    });

    test('cancelAll kills every live process and none that have finished', async () => {
        const calls: ExecCall[] = [];
        const killed: number[] = [];
        let pid = 1;
        const exec = ((command: string, options: any, callback: any) => {
            calls.push({ command, options, finish: (e, o, s) => callback(e, o, s) });
            return { pid: pid++ } as child_process.ChildProcess;
        }) as unknown as typeof child_process.exec;
        const runner = new CeedlingRunner({ exec, kill: (p) => killed.push(p) });
        const done = runner.run(invocation());
        runner.run(invocation());
        runner.run(invocation());
        calls[0].finish(null, '', '');
        await done;
        runner.cancelAll();
        assert.deepStrictEqual(killed.sort(), [2, 3]);
    });

    test('an exec double that calls back synchronously still resolves cleanly', async () => {
        const exec = ((_c: string, _o: any, callback: any) => {
            callback(null, 'sync', '');
            return { pid: 7 } as child_process.ChildProcess;
        }) as unknown as typeof child_process.exec;
        const killed: number[] = [];
        const runner = new CeedlingRunner({ exec, kill: (p) => killed.push(p) });
        assert.strictEqual((await runner.run(invocation())).stdout, 'sync');
        runner.cancelAll();
        assert.deepStrictEqual(killed, [], 'a finished process is not tracked as live');
    });
});

// Linux process-tree killing reads /proc instead of spawning `ps`, which minimal containers lack.
suite('process tree on Linux', () => {
    test('parseProcStatParent reads the parent pid after the command name', () => {
        assert.strictEqual(parseProcStatParent('4242 (ruby) S 4200 4242 4242 0 -1'), 4200);
    });

    test('parseProcStatParent survives spaces and parentheses in the command name', () => {
        assert.strictEqual(parseProcStatParent('77 (my (odd) proc) R 12 77 77 0'), 12);
    });

    test('parseProcStatParent rejects malformed text', () => {
        assert.strictEqual(parseProcStatParent('garbage'), undefined);
    });

    test('descendantsOf lists the root and every process beneath it, and nothing else', () => {
        const parents = new Map([[10, 1], [11, 10], [12, 11], [13, 10], [20, 1], [21, 20]]);
        assert.deepStrictEqual(descendantsOf(10, parents).sort((a, b) => a - b), [10, 11, 12, 13]);
    });
});
