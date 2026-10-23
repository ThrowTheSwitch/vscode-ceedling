import * as assert from 'assert';
import type * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type vscode from 'vscode';
import { CeedlingEngine, type EngineFileSystem, nodeFileSystem } from '../../src/ceedlingEngine';
import { type Cancellation, CeedlingRunner } from '../../src/ceedlingProcess';
import { CeedlingLoadError } from '../../src/ceedlingProjectConfig';
import type { Logger } from '../../src/logger';
import type { FileDiagnostic, ProblemMatcher } from '../../src/problemMatcher';
import { type CeedlingFileNode, type CeedlingProjectNode, leafIds, type RunReporter } from '../../src/testModel';

// Drives CeedlingEngine against a simulated Ceedling: an in-memory filesystem, and an exec double
// that answers each Ceedling command the way the real one does. See FakeCeedling below. Tests
// exercise the engine through its public API only.

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');
const BUNDLED_MIXIN = '/ext/assets/mixins/report-tests-log-factory.yml';
const WS = '/ws';

type Reply = { stdout?: string, stderr?: string, error?: boolean, writes?: Record<string, string> };
type Handler = (command: string, cwd: string) => Reply | Promise<Reply> | undefined;

// A Ceedling project at /ws by default. `version`, `dumpconfig`, and `files:test` answer from
// the fields below. Tests add handlers, checked first, for test runs and failures.
class FakeCeedling {
    files = new Map<string, string>();
    mtimes = new Map<string, number>();
    directories = new Set<string>([WS]);
    commands: Array<{ command: string, cwd: string, shell?: string }> = [];
    handlers: Handler[] = [];
    version = '1.2.0';
    resolvedConfig = `:plugins:\n  :enabled:\n    - report_tests_log_factory\n:unity:\n  :use_param_tests: true\n`;
    testFiles = ['test/test_calc.c'];
    killed: number[] = [];
    reads: string[] = [];
    readsInFlight = 0;
    maxReadsInFlight = 0;
    // Paths that refuse to be deleted, as a file held open on Windows does.
    undeletable = new Set<string>();
    // While set, every file read waits for it, so a test can observe reads in flight.
    readGate: Promise<void> | undefined;
    private clock = 1;

    constructor() {
        this.write(`${WS}/project.yml`, ':project: {}\n');
        this.write(`${WS}/test/test_calc.c`,
            'void test_add(void) {}\nvoid test_sub(void) {}\nTEST_CASE(1)\nTEST_CASE(2)\nvoid test_p(int x) {}\n');
    }

    write(file: string, content: string): void {
        this.files.set(file, content);
        this.mtimes.set(file, this.clock++);
    }

    get fileSystem(): EngineFileSystem {
        return {
            exists: async (p) => this.files.has(p),
            isDirectory: async (p) => this.directories.has(p),
            readFile: async (p) => {
                this.reads.push(p);
                this.readsInFlight++;
                this.maxReadsInFlight = Math.max(this.maxReadsInFlight, this.readsInFlight);
                await this.readGate;
                this.readsInFlight--;
                const content = this.files.get(p);
                if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
                return content;
            },
            unlink: async (p) => {
                if (this.undeletable.has(p)) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' });
                this.files.delete(p);
            },
            mtimeMs: async (p) => this.mtimes.get(p),
        };
    }

    get runner(): CeedlingRunner {
        let pid = 1000;
        const exec = ((command: string, options: child_process.ExecOptions, callback: any) => {
            const cwd = String(options.cwd);
            this.commands.push({ command, cwd, shell: options.shell });
            void Promise.resolve(this.reply(command, cwd)).then((reply) => {
                for (const [file, content] of Object.entries(reply.writes ?? {})) this.write(file, content);
                callback(reply.error ? new Error(`exit 1: ${command}`) : null, reply.stdout ?? '', reply.stderr ?? '');
            });
            return { pid: pid++ } as child_process.ChildProcess;
        }) as unknown as typeof child_process.exec;
        return new CeedlingRunner({ exec, kill: (p) => this.killed.push(p), env: {} });
    }

    private reply(command: string, cwd: string): Reply | Promise<Reply> {
        for (const handler of this.handlers) {
            const reply = handler(command, cwd);
            if (reply) return reply;
        }
        if (/^ceedling version/.test(command)) return { stdout: `Welcome to Ceedling!\n  Ceedling => ${this.version}\n` };
        if (/^ceedling dumpconfig --stdout/.test(command)) return { stdout: this.resolvedConfig };
        const dump = /^ceedling dumpconfig (\S+)/.exec(command);
        if (dump) return { writes: { [dump[1]]: this.resolvedConfig } };
        if (/^ceedling files:test/.test(command)) return { stdout: `Test files:\n${this.testFiles.map((f) => ` - ${f}`).join('\n')}\n` };
        return {};
    }

    // The CppUnit report a run would write to the project's test artifacts directory.
    reportWrite(xml: string, buildRoot = 'build'): Record<string, string> {
        return { [`${WS}/${buildRoot}/artifacts/test/cppunit_tests_report.xml`]: xml };
    }

    commandsMatching(pattern: RegExp): string[] {
        return this.commands.map((c) => c.command).filter((c) => pattern.test(c));
    }
}

function cppunit(parts: { passed?: string[], failed?: Array<{ name: string, message: string, line?: number }>, ignored?: string[] }): string {
    const tests = (names: string[] = []) => names.map((n) => `<Test><Name>${n}</Name></Test>`).join('');
    const failed = (parts.failed ?? []).map((f) =>
        `<Test><Name>${f.name}</Name>${f.line !== undefined ? `<Location><Line>${f.line}</Line></Location>` : ''}<Message>${f.message}</Message></Test>`).join('');
    return `<?xml version="1.0"?><TestRun><FailedTests>${failed}</FailedTests><SuccessfulTests>${tests(parts.passed)}</SuccessfulTests>` +
        `<IgnoredTests>${tests(parts.ignored)}</IgnoredTests></TestRun>`;
}

type LogCall = { level: string, message: string };

function fakeLogger(calls: LogCall[] = []): Logger {
    const record = (level: string) => (...args: unknown[]) => { calls.push({ level, message: args.map(String).join(' ') }); };
    return {
        trace: record('trace'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error'),
        showWarning: record('showWarning'), showError: record('showError'), dispose() { },
    } as unknown as Logger;
}

// Keeps diagnostics by id exactly as ProblemMatcher does, without a vscode DiagnosticCollection.
class FakeProblemMatcher {
    entries = new Map<string, FileDiagnostic[]>();
    matches: FileDiagnostic[] = [];
    match() { return this.matches; }
    set(id: string, diagnostics: FileDiagnostic[]) { this.entries.set(id, diagnostics); }
    retain(id: string, keep: (d: FileDiagnostic) => boolean) {
        const current = this.entries.get(id);
        if (current) this.entries.set(id, current.filter(keep));
    }
    retainIds(keep: (id: string) => boolean) {
        for (const id of [...this.entries.keys()]) if (!keep(id)) this.entries.delete(id);
    }
    clear() { this.entries.clear(); }
    disposed = false;
    dispose() { this.disposed = true; }
}

function diagnostic(file: string, line: number, severity: number, message: string): FileDiagnostic {
    return { file, diagnostic: { message, severity, range: { start: { line } } } } as unknown as FileDiagnostic;
}

type ReporterCall = [string, ...unknown[]];

function recordingReporter(): RunReporter & { calls: ReporterCall[], of(kind: string): ReporterCall[] } {
    const calls: ReporterCall[] = [];
    return {
        calls,
        of: (kind) => calls.filter((c) => c[0] === kind),
        started: (id) => calls.push(['started', id]),
        passed: (id) => calls.push(['passed', id]),
        failed: (id, message, line) => calls.push(['failed', id, message, line]),
        skipped: (id) => calls.push(['skipped', id]),
        errored: (id, message, location) => calls.push(['errored', id, message, location]),
        appendOutput: () => { },
    };
}

function token(): Cancellation & { fire(): void } {
    const listeners = new Set<() => void>();
    const t = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        fire() { t.isCancellationRequested = true; for (const l of [...listeners]) l(); },
    };
    return t;
}

function makeEngine(world: FakeCeedling, options: { settings?: Record<string, unknown>, logs?: LogCall[], problems?: FakeProblemMatcher, developmentMode?: boolean } = {}) {
    const settings = options.settings ?? {};
    return new CeedlingEngine(
        { uri: { fsPath: WS, toString: () => `file://${WS}` }, name: 'ws', index: 0 } as unknown as vscode.WorkspaceFolder,
        fakeLogger(options.logs),
        options.developmentMode ?? false,
        {
            configProvider: () => ({ get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback) }) as unknown as vscode.WorkspaceConfiguration,
            problemMatcher: (options.problems ?? new FakeProblemMatcher()) as unknown as ProblemMatcher,
            bundledMixinPath: BUNDLED_MIXIN,
            runner: world.runner,
            fileSystem: world.fileSystem,
            platform: 'linux',
            tmpdir: '/tmp',
        },
    );
}

async function discovered(world: FakeCeedling, options: Parameters<typeof makeEngine>[1] = {}): Promise<{ engine: CeedlingEngine, projects: CeedlingProjectNode[], file: CeedlingFileNode }> {
    const engine = makeEngine(world, options);
    const projects = await engine.discover();
    return { engine, projects, file: projects[0]?.files[0] };
}

const PROJECT_ARGS = `--project project.yml --mixin ${BUNDLED_MIXIN}`;

suite('CeedlingEngine.discover', () => {
    test('a folder without a project file is no project, and Ceedling never runs', async () => {
        const world = new FakeCeedling();
        world.files.delete(`${WS}/project.yml`);
        assert.deepStrictEqual(await makeEngine(world).discover(), []);
        assert.deepStrictEqual(world.commands, []);
    });

    test('checks the version in the project directory, then resolves its config and lists its tests', async () => {
        const world = new FakeCeedling();
        const { projects, file } = await discovered(world);
        assert.deepStrictEqual(world.commands.map((c) => c.cwd), [WS, WS, WS]);
        assert.strictEqual(world.commands[0].command, 'ceedling version');
        assert.strictEqual(world.commands[1].command, `ceedling dumpconfig --stdout ${PROJECT_ARGS}`);
        assert.strictEqual(world.commands[2].command, `ceedling files:test ${PROJECT_ARGS}`);
        assert.deepStrictEqual(projects.map((p) => p.projectKey), ['default']);
        assert.deepStrictEqual(leafIds(file.functions), [
            'test/test_calc.c::test_add', 'test/test_calc.c::test_sub', 'test/test_calc.c::test_p(1)', 'test/test_calc.c::test_p(2)',
        ]);
    });

    test('never runs `ceedling summary`', async () => {
        const world = new FakeCeedling();
        await discovered(world);
        assert.deepStrictEqual(world.commandsMatching(/summary/), []);
    });

    test('an unsupported Ceedling version is a load error naming it', async () => {
        const world = new FakeCeedling();
        world.version = '0.31.1';
        await assert.rejects(makeEngine(world).discover(), (e: unknown) => e instanceof CeedlingLoadError && /0\.31\.1/.test(e.message));
    });

    // Real builds report e.g. "1.2.0-13a540f". Semver would otherwise rank that below 1.2.0.
    test('a version with a build suffix is supported', async () => {
        const world = new FakeCeedling();
        world.version = '1.0.0-5bbbc8f';
        assert.strictEqual((await makeEngine(world).discover()).length, 1);
    });

    test('a Ceedling that will not run is a load error about running it, not about its version', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^ceedling version/.test(command) ? { error: true, stderr: 'ceedling: command not found' } : undefined);
        await assert.rejects(makeEngine(world).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && /ceedling version/.test(e.message) && /shellPath/.test(e.message) && !/0\.0\.0/.test(e.message));
    });

    test('a failed dumpconfig is a load error naming the project and the settings to check', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /dumpconfig/.test(command) ? { error: true, stderr: 'bad mixin' } : undefined);
        await assert.rejects(makeEngine(world).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && /default/.test(e.message) && /shellPath/.test(e.message) && /mixins/.test(e.message));
    });

    test('a resolved config without the report plugin is a load error', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = ':plugins:\n  :enabled: []\n';
        await assert.rejects(makeEngine(world).discover(), (e: unknown) => e instanceof CeedlingLoadError && /report_tests_log_factory/.test(e.message));
    });

    test('a non-default report filename warns once, across discoveries', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig += ':report_tests_log_factory:\n  :cppunit:\n    :filename: custom.xml\n';
        const logs: LogCall[] = [];
        const engine = makeEngine(world, { logs });
        await engine.discover();
        await engine.discover();
        const warnings = logs.filter((l) => l.level === 'showWarning');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0].message, /custom\.xml/);
    });

    test('parametrized cases follow the resolved :use_param_tests:', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = ':plugins:\n  :enabled:\n    - report_tests_log_factory\n';
        const { file } = await discovered(world);
        assert.deepStrictEqual(file.functions.map((f) => f.cases.length), [0, 0, 0]);
    });

    test('pretty labels are on by default and can be turned off', async () => {
        const pretty = (await discovered(new FakeCeedling())).file;
        assert.strictEqual(pretty.label, 'calc');
        assert.strictEqual(pretty.functions[0].label, 'add');
        const plain = (await discovered(new FakeCeedling(), { settings: { prettyTestLabel: false, prettyTestFileLabel: false } })).file;
        assert.strictEqual(plain.label, 'test/test_calc.c');
        assert.strictEqual(plain.functions[0].label, 'test_add');
    });

    test("each project's configured mixins are passed lowest to highest, before the bundled mixin", async () => {
        const world = new FakeCeedling();
        await discovered(world, { settings: { projects: [{ path: '.', debugLaunchConfig: 'dbg', mixins: ['gcc', 'cov.yml'] }] } });
        assert.match(world.commands[2].command, new RegExp(`--project project.yml --mixin gcc --mixin cov.yml --mixin ${BUNDLED_MIXIN}$`));
    });

    test('an unreadable test file is skipped with a warning', async () => {
        const world = new FakeCeedling();
        world.testFiles = ['test/test_calc.c', 'test/test_missing.c'];
        const logs: LogCall[] = [];
        const { projects } = await discovered(world, { logs });
        assert.deepStrictEqual(projects[0].files.map((f) => f.id), ['test/test_calc.c']);
        assert.ok(logs.some((l) => l.level === 'warn' && /test_missing/.test(l.message)));
    });

    test('dumpconfig output that is not YAML is a load error, with the parse error logged', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = ':plugins: [unclosed\n';
        const logs: LogCall[] = [];
        await assert.rejects(makeEngine(world, { logs }).discover(), (e: unknown) => e instanceof CeedlingLoadError && /dumpconfig/.test(e.message));
        assert.ok(logs.some((l) => l.level === 'error' && /could not parse dumpconfig output/.test(l.message)));
    });

    test('a failed test listing is logged, and leaves the project without test files', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^ceedling files:test/.test(command) ? { error: true, stderr: 'boom' } : undefined);
        const logs: LogCall[] = [];
        const { projects } = await discovered(world, { logs });
        assert.deepStrictEqual(projects[0].files, []);
        assert.ok(logs.some((l) => l.level === 'error' && /files:test/.test(l.message)));
    });

    test("a test file's discovery warnings are logged, naming the file", async () => {
        const world = new FakeCeedling();
        world.write(`${WS}/test/test_calc.c`, 'TEST_RANGE([0, 2, 0])\nvoid test_z(int x) {}\n');
        const logs: LogCall[] = [];
        await discovered(world, { logs });
        assert.ok(logs.some((l) => l.level === 'warn' && /test\/test_calc\.c/.test(l.message) && /zero step/.test(l.message)));
    });

    test('a test file prefix that is not a valid pattern leaves file labels plain, with a warning', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig += ':project:\n  :test_file_prefix: "test_("\n';
        world.testFiles = ['test/test_(calc.c'];
        world.write(`${WS}/test/test_(calc.c`, 'void test_add(void) {}\n');
        const logs: LogCall[] = [];
        const { file } = await discovered(world, { logs });
        assert.strictEqual(file.label, 'test/test_(calc.c');
        assert.strictEqual(file.functions[0].label, 'add');
        assert.ok(logs.some((l) => l.level === 'warn' && /Pretty labels are unavailable/.test(l.message)));
    });

    test('the project file is watched even when discovery fails', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = ':plugins:\n  :enabled: []\n';
        const engine = makeEngine(world);
        await assert.rejects(engine.discover());
        assert.ok((await engine.configurationFiles()).includes(`${WS}/project.yml`));
    });

    // A failed rediscovery must not leave runs without their --project/--mixin flags and cwd.
    test('a failed rediscovery keeps the last good projects for runs', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.version = '0.1.0';
        await assert.rejects(engine.discover());
        await engine.runFile('default', file, recordingReporter(), token());
        const run = world.commands[world.commands.length - 1];
        assert.strictEqual(run.command, `ceedling test:test/test_calc.c --force-test-rerun ${PROJECT_ARGS}`);
        assert.strictEqual(run.cwd, WS);
    });
});

// Ceedling 1.2.0 added `dumpconfig --stdout`, path-qualified `test:` tasks, delta builds, and
// ceedling.yml. The suites above simulate 1.2.0. This one pins the behavior before it.
suite('CeedlingEngine with Ceedling before 1.2.0', () => {
    test('dumpconfig writes a temporary file, which is removed', async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10-85ec551';
        await discovered(world);
        assert.match(world.commands[1].command, new RegExp(`^ceedling dumpconfig /tmp/\\S+\\.yml ${PROJECT_ARGS}$`));
        assert.ok(![...world.files.keys()].some((f) => f.startsWith('/tmp/')));
    });

    test('a failed dumpconfig is a load error, logged', async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        world.handlers.push((command) => /^ceedling dumpconfig/.test(command) ? { error: true } : undefined);
        const logs: LogCall[] = [];
        await assert.rejects(makeEngine(world, { logs }).discover(), CeedlingLoadError);
        assert.ok(logs.some((l) => l.level === 'error' && /'ceedling dumpconfig' failed/.test(l.message)));
    });

    test('a dumpconfig that writes no file is a load error, logged', async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        world.handlers.push((command) => /^ceedling dumpconfig/.test(command) ? {} : undefined);
        const logs: LogCall[] = [];
        await assert.rejects(makeEngine(world, { logs }).discover(), CeedlingLoadError);
        assert.ok(logs.some((l) => l.level === 'error' && /could not read dumpconfig output/.test(l.message)));
    });

    test("a temporary file that can't be removed doesn't fail discovery", async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        world.handlers.push((command) => {
            const dump = /^ceedling dumpconfig (\S+)/.exec(command);
            if (dump) world.undeletable.add(dump[1]);
            return undefined;
        });
        assert.strictEqual((await makeEngine(world).discover()).length, 1);
    });

    test("test tasks name the file alone and don't force a rerun", async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        const { engine, file } = await discovered(world);
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling test:/), [`ceedling test:test_calc.c --test-case=test_add ${PROJECT_ARGS}`]);
    });

    test('a folder with both project files uses project.yml without complaint', async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        world.write(`${WS}/ceedling.yml`, ':project: {}\n');
        const { projects } = await discovered(world);
        assert.strictEqual(projects.length, 1);
        assert.match(world.commands[2].command, /--project project\.yml/);
    });
});

suite('CeedlingEngine with Ceedling 1.2.0', () => {
    test('dumpconfig output is read from stdout, past any leading log lines', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /dumpconfig --stdout/.test(command) ? { stdout: `WARNING: something\n---\n${world.resolvedConfig}` } : undefined);
        assert.strictEqual((await makeEngine(world).discover()).length, 1);
        assert.ok(![...world.files.keys()].some((f) => f.startsWith('/tmp/')));
    });

    test('a folder holding only ceedling.yml is a project using it', async () => {
        const world = new FakeCeedling();
        world.files.delete(`${WS}/project.yml`);
        world.write(`${WS}/ceedling.yml`, ':project: {}\n');
        const { engine, projects } = await discovered(world);
        assert.strictEqual(projects.length, 1);
        assert.match(world.commands[2].command, new RegExp(`--project ceedling\\.yml --mixin ${BUNDLED_MIXIN}$`));
        assert.ok((await engine.configurationFiles()).includes(`${WS}/ceedling.yml`));
    });

    // Ceedling itself refuses this ambiguity, but only when no --project names the file.
    test('a folder holding both project files is a load error naming both', async () => {
        const world = new FakeCeedling();
        world.write(`${WS}/ceedling.yml`, ':project: {}\n');
        await assert.rejects(makeEngine(world).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && /project\.yml/.test(e.message) && /ceedling\.yml/.test(e.message));
    });

    test('an alternate project file and either base are watched', async () => {
        const world = new FakeCeedling();
        world.directories.add(`${WS}/fw`);
        world.write(`${WS}/fw/project.yml`, ':project: {}\n');
        world.write(`${WS}/fw/ci.yml`, ':project: {}\n');
        const engine = makeEngine(world, { settings: { projects: [{ path: 'fw/ci.yml', debugLaunchConfig: 'dbg' }] } });
        assert.deepStrictEqual((await engine.configurationFiles()).sort(), [`${WS}/fw/ceedling.yml`, `${WS}/fw/ci.yml`, `${WS}/fw/project.yml`]);
    });

    // 1.2.0 nests each executable under its test file's directory, relative to the test path.
    test("a nested test file's executable is found under its directory", async () => {
        const world = new FakeCeedling();
        world.testFiles = ['test/unit/test_calc.c'];
        world.write(`${WS}/test/unit/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? {
            writes: {
                ...world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add'] })),
                [`${WS}/build/test/out/unit/test_calc/test_calc.out`]: 'ELF',
            },
        } : undefined);
        assert.strictEqual(await engine.compileForDebug('default', file, recordingReporter(), token()), 'unit/test_calc/test_calc.out');
        assert.deepStrictEqual(world.commandsMatching(/^ceedling test:/), [`ceedling test:test/unit/test_calc.c --force-test-rerun ${PROJECT_ARGS}`]);
    });
});

suite('CeedlingEngine runs', () => {
    test('a file run reports each result, failures with their line and the run transcript', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? {
            stdout: 'TRANSCRIPT',
            writes: world.reportWrite(cppunit({
                passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_p(1)', 'test/test_calc.c::test_p(2)'],
                failed: [{ name: 'test/test_calc.c::test_sub', message: 'Expected 1 Was 2', line: 5 }],
            })),
        } : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        assert.deepStrictEqual(reporter.of('started').map((c) => c[1]), [
            'test/test_calc.c', 'test/test_calc.c::test_add', 'test/test_calc.c::test_sub', 'test/test_calc.c::test_p',
            'test/test_calc.c::test_p(1)', 'test/test_calc.c::test_p(2)',
        ]);
        assert.deepStrictEqual(reporter.of('passed').map((c) => c[1]), ['test/test_calc.c::test_add', 'test/test_calc.c::test_p(1)', 'test/test_calc.c::test_p(2)']);
        const [failed] = reporter.of('failed');
        assert.strictEqual(failed[1], 'test/test_calc.c::test_sub');
        assert.match(String(failed[2]), /^Expected 1 Was 2\n\nstdout:\nTRANSCRIPT/);
        assert.strictEqual(failed[3], 4);
    });

    test('a test Ceedling did not report is errored, not left to end as skipped', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_p(1)', 'test/test_calc.c::test_p(2)'] })) }
            : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        const errored = reporter.of('errored');
        assert.deepStrictEqual(errored.map((c) => c[1]), ['test/test_calc.c::test_sub']);
        assert.match(String(errored[0][2]), /reported no result/);
    });

    test('an ignored test is skipped', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add'], ignored: ['test/test_calc.c::test_sub'] })) }
            : undefined);
        const reporter = recordingReporter();
        await engine.runFunction('default', file, file.functions[1], reporter, token());
        assert.deepStrictEqual(reporter.of('skipped').map((c) => c[1]), ['test/test_calc.c::test_sub']);
    });

    test('results matching no discovered test are logged', async () => {
        const world = new FakeCeedling();
        const logs: LogCall[] = [];
        const { engine, file } = await discovered(world, { logs });
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_gone'] })) }
            : undefined);
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token());
        assert.ok(logs.some((l) => l.level === 'warn' && /test_gone/.test(l.message)));
    });

    test('a failure without a location still reports, without a line', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? { writes: world.reportWrite(cppunit({ failed: [{ name: 'test/test_calc.c::test_add', message: 'crashed' }] })) }
            : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        assert.strictEqual(reporter.of('failed')[0][3], undefined);
    });

    test('with no report, every id errors with the most severe diagnostic leading', async () => {
        const world = new FakeCeedling();
        const problems = new FakeProblemMatcher();
        problems.matches = [diagnostic('/ws/a.h', 2, 1, 'a warning'), diagnostic('/ws/test/test_calc.c', 7, 0, 'the error')];
        const { engine, file } = await discovered(world, { problems });
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { error: true, stderr: 'build failed' } : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        const errored = reporter.of('errored');
        assert.strictEqual(errored.length, 6);
        assert.match(String(errored[0][2]), /^the error\n\nstderr:\nbuild failed/);
        assert.deepStrictEqual(errored[0][3], { file: '/ws/test/test_calc.c', line: 7 });
    });

    // A report left over from an earlier run, in either artifacts directory, must not be read as this run's.
    test('stale test and gcov reports are deleted before a run', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        const stale = cppunit({ passed: ['test/test_calc.c::test_add'] });
        world.write(`${WS}/build/artifacts/test/cppunit_tests_report.xml`, stale);
        world.write(`${WS}/build/artifacts/gcov/cppunit_tests_report.xml`, stale);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { error: true } : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        assert.deepStrictEqual(reporter.of('passed'), []);
        assert.strictEqual(reporter.of('errored').length, 6);
    });

    test("a stale report that can't be deleted is warned about, and the run goes on", async () => {
        const world = new FakeCeedling();
        const logs: LogCall[] = [];
        const { engine, file } = await discovered(world, { logs });
        const stale = `${WS}/build/artifacts/test/cppunit_tests_report.xml`;
        world.write(stale, cppunit({}));
        world.undeletable.add(stale);
        await engine.runFile('default', file, recordingReporter(), token());
        assert.ok(logs.some((l) => l.level === 'warn' && l.message.includes(stale)));
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 1);
    });

    test('a cancelled run marks its tests skipped, not errored', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        const cancel = token();
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? new Promise<Reply>((resolve) => setImmediate(() => { cancel.fire(); resolve({ error: true }); }))
            : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, cancel);
        assert.deepStrictEqual(reporter.of('errored'), []);
        assert.deepStrictEqual(reporter.of('skipped').map((c) => c[1]), leafIds(file.functions));
        assert.strictEqual(world.killed.length, 1);
    });

    test('an already-cancelled run never starts Ceedling', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        const before = world.commands.length;
        const cancel = token();
        cancel.fire();
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, cancel);
        assert.strictEqual(world.commands.length, before);
        assert.strictEqual(reporter.of('skipped').length, 4);
    });

    test('a function run narrows with --test-case', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add'] })) } : undefined);
        const reporter = recordingReporter();
        await engine.runFunction('default', file, file.functions[0], reporter, token());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling test:/), [`ceedling test:test/test_calc.c --test-case=test_add --force-test-rerun ${PROJECT_ARGS}`]);
        assert.deepStrictEqual(reporter.of('passed').map((c) => c[1]), ['test/test_calc.c::test_add']);
    });

    // Ceedling's filter is a substring match: test_add also selects test_add_more.
    test('a function run that also catches an unrelated test falls back to the whole file', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /--test-case/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_add_more'] })) }
            : undefined);
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling test:/), [
            `ceedling test:test/test_calc.c --test-case=test_add --force-test-rerun ${PROJECT_ARGS}`,
            `ceedling test:test/test_calc.c --force-test-rerun ${PROJECT_ARGS}`,
        ]);
    });

    test('a project run uses test:all', async () => {
        const world = new FakeCeedling();
        const { engine, projects } = await discovered(world);
        await engine.runProjectAll('default', projects[0].files, recordingReporter(), token());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling test:/), [`ceedling test:all --force-test-rerun ${PROJECT_ARGS}`]);
    });

    test('every ${TEST_ID} in a configured argument is replaced', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world, { settings: { testCommandArgs: ['test:${TEST_ID}', 'gcov:${TEST_ID}/${TEST_ID}'] } });
        await engine.runFile('default', file, recordingReporter(), token());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling test:/), [`ceedling test:test/test_calc.c gcov:test/test_calc.c/test/test_calc.c --force-test-rerun ${PROJECT_ARGS}`]);
    });

    test('development mode adds debug verbosity as two arguments', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world, { developmentMode: true });
        await engine.runFile('default', file, recordingReporter(), token());
        assert.match(world.commandsMatching(/^ceedling test:/)[0], / --verbosity debug$/);
    });

    test("development mode logs a run's stdout and stderr", async () => {
        const world = new FakeCeedling();
        const logs: LogCall[] = [];
        const { engine, file } = await discovered(world, { logs, developmentMode: true });
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { stdout: 'OUT', stderr: 'ERR' } : undefined);
        await engine.runFile('default', file, recordingReporter(), token());
        assert.ok(logs.some((l) => l.level === 'debug' && /^stdout:\nOUT\nstderr:\nERR$/.test(l.message)));
    });

    test('runs wait for one another', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        let release!: () => void;
        world.handlers.push((command) => /^ceedling test:/.test(command) && world.commandsMatching(/^ceedling test:/).length === 1
            ? new Promise<Reply>((resolve) => { release = () => resolve({}); })
            : undefined);
        const first = engine.runFile('default', file, recordingReporter(), token());
        const second = engine.runFile('default', file, recordingReporter(), token());
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 1);
        release();
        await Promise.all([first, second]);
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 2);
    });
});

suite('CeedlingEngine diagnostics', () => {
    test("a file run replaces its own entry and drops the project entry's diagnostics in that file", async () => {
        const world = new FakeCeedling();
        const problems = new FakeProblemMatcher();
        const { engine, projects, file } = await discovered(world, { problems });
        problems.matches = [diagnostic('/ws/test/test_calc.c', 3, 0, 'old'), diagnostic('/ws/src/other.c', 1, 0, 'other')];
        await engine.runProjectAll('default', projects[0].files, recordingReporter(), token());
        problems.matches = [];
        await engine.runFile('default', file, recordingReporter(), token());
        assert.deepStrictEqual(problems.entries.get('default')!.map((d) => d.diagnostic.message), ['other']);
        assert.deepStrictEqual(problems.entries.get('default::test/test_calc.c'), []);
    });

    test("a project run replaces the project entry and supersedes its files' entries", async () => {
        const world = new FakeCeedling();
        const problems = new FakeProblemMatcher();
        const { engine, projects, file } = await discovered(world, { problems });
        problems.matches = [diagnostic('/ws/test/test_calc.c', 3, 0, 'stale')];
        await engine.runFile('default', file, recordingReporter(), token());
        problems.matches = [];
        await engine.runProjectAll('default', projects[0].files, recordingReporter(), token());
        assert.deepStrictEqual([...problems.entries.keys()], ['default']);
    });

    test('discovery drops entries for files and projects that no longer exist', async () => {
        const world = new FakeCeedling();
        const problems = new FakeProblemMatcher();
        problems.entries.set('default::test/test_gone.c', []);
        problems.entries.set('old-project', []);
        problems.entries.set('default::test/test_calc.c', []);
        await discovered(world, { problems });
        assert.deepStrictEqual([...problems.entries.keys()], ['default::test/test_calc.c']);
    });
});

suite('CeedlingEngine.compileForDebug', () => {
    test("reports the build's real results and returns the executable's path", async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? { writes: world.reportWrite(cppunit({ failed: [{ name: 'test/test_calc.c::test_add', message: 'nope', line: 1 }] })) }
            : undefined);
        const reporter = recordingReporter();
        assert.strictEqual(await engine.compileForDebug('default', file, reporter, token()), 'test_calc/test_calc.out');
        assert.deepStrictEqual(reporter.of('failed').map((c) => c[1]), ['test/test_calc.c::test_add']);
        assert.deepStrictEqual(reporter.of('passed'), []);
    });

    test('a failed build errors every id and returns no executable', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { error: true } : undefined);
        const reporter = recordingReporter();
        assert.strictEqual(await engine.compileForDebug('default', file, reporter, token()), undefined);
        assert.strictEqual(reporter.of('errored').length, 6);
        assert.deepStrictEqual(reporter.of('failed'), []);
    });

    test('a cancelled build marks its tests skipped and returns no executable', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        const cancel = token();
        world.handlers.push((command) => /^ceedling test:/.test(command)
            ? new Promise<Reply>((resolve) => setImmediate(() => { cancel.fire(); resolve({ error: true }); }))
            : undefined);
        const reporter = recordingReporter();
        assert.strictEqual(await engine.compileForDebug('default', file, reporter, cancel), undefined);
        assert.deepStrictEqual(reporter.of('skipped').map((c) => c[1]), leafIds(file.functions));
        assert.deepStrictEqual(reporter.of('errored'), []);
    });

    test('waits for a run in progress', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        let release!: () => void;
        world.handlers.push((command) => /^ceedling test:/.test(command) && world.commandsMatching(/^ceedling test:/).length === 1
            ? new Promise<Reply>((resolve) => { release = () => resolve({}); })
            : undefined);
        const run = engine.runFile('default', file, recordingReporter(), token());
        const debug = engine.compileForDebug('default', file, recordingReporter(), token());
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 1);
        release();
        await Promise.all([run, debug]);
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 2);
    });
});

suite('CeedlingEngine clean and clobber', () => {
    test('clean waits for a run in progress, then runs in each project', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        let release!: () => void;
        world.handlers.push((command) => /^ceedling test:/.test(command) ? new Promise<Reply>((resolve) => { release = () => resolve({}); }) : undefined);
        const run = engine.runFile('default', file, recordingReporter(), token());
        const clean = engine.clean();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(world.commandsMatching(/^ceedling clean/), []);
        release();
        await run;
        assert.strictEqual(await clean, true);
        assert.deepStrictEqual(world.commandsMatching(/^ceedling clean/), [`ceedling clean ${PROJECT_ARGS}`]);
    });

    test('clobber reports a failure', async () => {
        const world = new FakeCeedling();
        const { engine } = await discovered(world);
        world.handlers.push((command) => /^ceedling clobber/.test(command) ? { error: true } : undefined);
        assert.strictEqual(await engine.clobber(), false);
    });
});

suite('CeedlingEngine against real Ceedling output', () => {
    // Discovered ids must equal the names Ceedling reports for the same source. The reports were
    // captured from tests/fixtures/source/test_whitespace.c (issue #14), see tests/fixtures/README.md.
    for (const version of ['ceedling-1.0.0', 'ceedling-1.1.10', 'ceedling-1.2.0']) {
        test(`${version}: every test in test_whitespace.c gets its reported result`, async () => {
            const world = new FakeCeedling();
            world.testFiles = ['test/test_whitespace.c'];
            world.write(`${WS}/test/test_whitespace.c`, fs.readFileSync(path.resolve(fixturesRoot, 'source', 'test_whitespace.c'), 'utf8'));
            const report = fs.readFileSync(path.resolve(fixturesRoot, version, 'cppunit-report-whitespace.xml'), 'utf8');
            const { engine, file } = await discovered(world);
            world.handlers.push((command) => /^ceedling test:/.test(command) ? { writes: world.reportWrite(report) } : undefined);
            const reporter = recordingReporter();
            await engine.runFile('default', file, reporter, token());
            assert.deepStrictEqual(reporter.of('passed').map((c) => c[1]), leafIds(file.functions));
            assert.deepStrictEqual(reporter.of('errored'), []);
        });
    }
});

suite('CeedlingEngine for watchers and editing', () => {
    // A project file that doesn't exist yet is watched too, so creating one starts discovery.
    test("configuration files include absent default project files and each project's file-path mixins", async () => {
        const world = new FakeCeedling();
        world.directories.add(`${WS}/fw`);
        const engine = makeEngine(world, { settings: { projects: [{ path: 'fw', debugLaunchConfig: 'dbg', mixins: ['gcc', 'mixins/cov.yml'] }] } });
        assert.deepStrictEqual((await engine.configurationFiles()).sort(), [`${WS}/fw/ceedling.yml`, `${WS}/fw/mixins/cov.yml`, `${WS}/fw/project.yml`]);
    });

    test('configuration files are empty, not an error, when settings name a missing directory', async () => {
        const engine = makeEngine(new FakeCeedling(), { settings: { projects: [{ path: 'nope', debugLaunchConfig: 'dbg' }] } });
        assert.deepStrictEqual((await engine.configurationFiles()), []);
    });

    test('a discovered test file is found by its absolute path', async () => {
        const { engine } = await discovered(new FakeCeedling());
        assert.deepStrictEqual(engine.testFileAt(`${WS}/test/test_calc.c`), { projectKey: 'default', fileId: 'test/test_calc.c' });
        assert.strictEqual(engine.testFileAt(`${WS}/src/calc.c`), undefined);
    });

    test('a new file in a project may be a test file when it has the test file prefix', async () => {
        const { engine } = await discovered(new FakeCeedling());
        assert.strictEqual(engine.mayBeTestFile(`${WS}/test/sub/test_new.c`), true);
        assert.strictEqual(engine.mayBeTestFile(`${WS}/src/calc.c`), false);
        assert.strictEqual(engine.mayBeTestFile('/elsewhere/test_x.c'), false);
    });

    test('rediscovering one file reparses its source without running Ceedling', async () => {
        const world = new FakeCeedling();
        const { engine } = await discovered(world);
        const before = world.commands.length;
        const file = await engine.rediscoverFile('default', 'test/test_calc.c', 'void test_only(void) {}\n');
        assert.deepStrictEqual(file!.functions.map((f) => f.id), ['test/test_calc.c::test_only']);
        assert.strictEqual(file!.functions[0].label, 'only');
        assert.strictEqual(world.commands.length, before);
    });

    test('rediscovering reads the saved file when no source is given', async () => {
        const world = new FakeCeedling();
        const { engine } = await discovered(world);
        world.write(`${WS}/test/test_calc.c`, 'void test_saved(void) {}\n');
        const file = await engine.rediscoverFile('default', 'test/test_calc.c');
        assert.deepStrictEqual(file!.functions.map((f) => f.id), ['test/test_calc.c::test_saved']);
    });

    test('rediscovering an unknown file finds nothing', async () => {
        const { engine } = await discovered(new FakeCeedling());
        assert.strictEqual(await engine.rediscoverFile('default', 'test/test_unknown.c', ''), undefined);
    });

    test('the configured Ceedling command starts every invocation', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^bundle exec ceedling version/.test(command) ? { stdout: 'Ceedling => 1.2.0\n' } : undefined);
        world.handlers.push((command) => /^bundle exec ceedling dumpconfig --stdout/.test(command) ? { stdout: world.resolvedConfig } : undefined);
        world.handlers.push((command) => /^bundle exec ceedling files:test/.test(command) ? { stdout: ' - test/test_calc.c\n' } : undefined);
        await discovered(world, { settings: { ceedlingCommand: 'bundle exec ceedling' } });
        assert.ok(world.commands.length > 0);
        assert.ok(world.commands.every((c) => c.command.startsWith('bundle exec ceedling ')));
    });

    test('a blank Ceedling command means ceedling', async () => {
        const world = new FakeCeedling();
        await discovered(world, { settings: { ceedlingCommand: '  ' } });
        assert.ok(world.commands.every((c) => c.command.startsWith('ceedling ')));
    });

    // VS Code settings can hold the string "null" where the JSON null was meant.
    test('the configured shell runs every invocation, and "null" means the default shell', async () => {
        const configured = new FakeCeedling();
        await discovered(configured, { settings: { shellPath: '/bin/bash' } });
        assert.ok(configured.commands.every((c) => c.shell === '/bin/bash'));
        const literalNull = new FakeCeedling();
        await discovered(literalNull, { settings: { shellPath: 'null' } });
        assert.ok(literalNull.commands.every((c) => c.shell === undefined));
    });
});

suite('CeedlingEngine lookups and lifecycle', () => {
    test("a project's debug configuration and directory are found by its key", async () => {
        const world = new FakeCeedling();
        world.directories.add(`${WS}/fw`);
        world.write(`${WS}/fw/project.yml`, ':project: {}\n');
        const { engine } = await discovered(world, { settings: { projects: [{ path: 'fw', debugLaunchConfig: 'gdb (fw)' }] } });
        assert.strictEqual(engine.getDebugLaunchConfig('fw'), 'gdb (fw)');
        assert.strictEqual(engine.getProjectAbsPath('fw'), `${WS}/fw`);
    });

    test('an unknown project key is an error naming it', async () => {
        const { engine, file } = await discovered(new FakeCeedling());
        assert.throws(() => engine.getProjectAbsPath('nope'), /Unknown Ceedling project 'nope'/);
        await assert.rejects(engine.runFile('nope', file, recordingReporter(), token()), /Unknown Ceedling project 'nope'/);
    });

    test('rediscovering a file in an unknown project finds nothing', async () => {
        const { engine, file } = await discovered(new FakeCeedling());
        assert.strictEqual(await engine.rediscoverFile('nope', file.id, ''), undefined);
    });

    test('cancel stops every running Ceedling process', async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        let release!: () => void;
        world.handlers.push((command) => /^ceedling test:/.test(command) ? new Promise<Reply>((resolve) => { release = () => resolve({}); }) : undefined);
        const run = engine.runFile('default', file, recordingReporter(), token());
        await new Promise((resolve) => setImmediate(resolve));
        engine.cancel();
        assert.strictEqual(world.killed.length, 1);
        release();
        await run;
    });

    test('dispose stops running processes and disposes the problem matcher', async () => {
        const world = new FakeCeedling();
        const problems = new FakeProblemMatcher();
        const { engine, file } = await discovered(world, { problems });
        let release!: () => void;
        world.handlers.push((command) => /^ceedling test:/.test(command) ? new Promise<Reply>((resolve) => { release = () => resolve({}); }) : undefined);
        const run = engine.runFile('default', file, recordingReporter(), token());
        await new Promise((resolve) => setImmediate(resolve));
        engine.dispose();
        assert.strictEqual(world.killed.length, 1);
        assert.strictEqual(problems.disposed, true);
        release();
        await run;
    });

    // Default dependencies: the real filesystem and process runner.
    test('with only its required dependencies, a folder without a project file on disk is no project', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ceedling-engine-'));
        try {
            const engine = new CeedlingEngine(
                { uri: { fsPath: folder, toString: () => `file://${folder}` }, name: 'empty', index: 0 } as unknown as vscode.WorkspaceFolder,
                fakeLogger(), false,
                {
                    configProvider: () => ({ get: (_key: string, fallback?: unknown) => fallback }) as unknown as vscode.WorkspaceConfiguration,
                    problemMatcher: new FakeProblemMatcher() as unknown as ProblemMatcher,
                    bundledMixinPath: BUNDLED_MIXIN,
                },
            );
            assert.deepStrictEqual(await engine.discover(), []);
        } finally {
            fs.rmSync(folder, { recursive: true, force: true });
        }
    });
});

suite('nodeFileSystem', () => {
    let folder: string;
    setup(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ceedling-fs-')); });
    teardown(() => { fs.rmSync(folder, { recursive: true, force: true }); });

    test('a file exists, has a modification time, reads back, and is gone once unlinked', async () => {
        const file = path.join(folder, 'project.yml');
        fs.writeFileSync(file, ':project: {}\n');
        assert.strictEqual(await nodeFileSystem.exists(file), true);
        assert.strictEqual(await nodeFileSystem.isDirectory(file), false);
        assert.strictEqual(typeof await nodeFileSystem.mtimeMs(file), 'number');
        assert.strictEqual(await nodeFileSystem.readFile(file), ':project: {}\n');
        await nodeFileSystem.unlink(file);
        assert.strictEqual(await nodeFileSystem.exists(file), false);
    });

    test('a directory is a directory', async () => {
        assert.strictEqual(await nodeFileSystem.isDirectory(folder), true);
    });

    test('a missing path does not exist, is no directory, and has no modification time, without an error', async () => {
        const missing = path.join(folder, 'missing');
        assert.strictEqual(await nodeFileSystem.exists(missing), false);
        assert.strictEqual(await nodeFileSystem.isDirectory(missing), false);
        assert.strictEqual(await nodeFileSystem.mtimeMs(missing), undefined);
    });
});

// Each Ceedling start costs a Ruby startup, so discovery overlaps work it can. Two Ceedling
// processes in one project directory could collide on its build files, so that never overlaps.
suite('CeedlingEngine concurrent discovery', () => {
    function twoProjects(world: FakeCeedling, a: string, b: string) {
        for (const dir of new Set([a, b].map((p) => p.replace(/\/[^/]*\.yml$/, '')))) {
            world.directories.add(`${WS}/${dir}`);
            world.write(`${WS}/${dir}/project.yml`, ':project: {}\n');
        }
        for (const file of [a, b].filter((p) => p.endsWith('.yml'))) world.write(`${WS}/${file}`, ':project: {}\n');
        return { projects: [{ path: a, debugLaunchConfig: 'dbg' }, { path: b, debugLaunchConfig: 'dbg' }] };
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    test('projects in different directories are checked at the same time', async () => {
        const world = new FakeCeedling();
        let release!: () => void;
        const held = new Promise<Reply>((resolve) => { release = () => resolve({ stdout: 'Ceedling => 1.2.0\n' }); });
        world.handlers.push((command) => /^ceedling version/.test(command) ? held : undefined);
        const discovery = makeEngine(world, { settings: twoProjects(world, 'a', 'b') }).discover();
        await settle();
        assert.deepStrictEqual(world.commands.filter((c) => /version/.test(c.command)).map((c) => c.cwd).sort(), [`${WS}/a`, `${WS}/b`]);
        release();
        assert.strictEqual((await discovery).length, 2);
    });

    test('projects sharing a directory are loaded one after the other', async () => {
        const world = new FakeCeedling();
        let release!: () => void;
        const held = new Promise<Reply>((resolve) => { release = () => resolve({ stdout: 'Ceedling => 1.2.0\n' }); });
        world.handlers.push((command) => /^ceedling version/.test(command) && world.commandsMatching(/version/).length === 1 ? held : undefined);
        const discovery = makeEngine(world, { settings: twoProjects(world, 'fw/ci.yml', 'fw/other.yml') }).discover();
        await settle();
        assert.strictEqual(world.commandsMatching(/version/).length, 1);
        release();
        assert.strictEqual((await discovery).length, 2);
    });

    test('load errors name the first failing project in settings order, however the checks finish', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command, cwd) => /^ceedling version/.test(command)
            ? (cwd.endsWith('/a')
                ? new Promise<Reply>((resolve) => setTimeout(() => resolve({ error: true }), 20))
                : { error: true })
            : undefined);
        await assert.rejects(makeEngine(world, { settings: twoProjects(world, 'a', 'b') }).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && /project 'a'/.test(e.message));
    });

    test('several failed configurations are reported together, in settings order', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command, cwd) => /dumpconfig/.test(command)
            ? (cwd.endsWith('/a')
                ? new Promise<Reply>((resolve) => setTimeout(() => resolve({ error: true }), 20))
                : { error: true })
            : undefined);
        await assert.rejects(makeEngine(world, { settings: twoProjects(world, 'a', 'b') }).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && e.message.indexOf("'a'") < e.message.indexOf("'b'") && e.message.includes("'a'"));
    });

    // Every Ceedling command that loads a project rewrites the Unity copy in its build directory, so
    // a configuration check during a build in the same directory could corrupt that build.
    test("a rediscovery's configuration check waits for a build in the same directory", async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        let release!: () => void;
        world.handlers.push((command) => /^ceedling test:/.test(command) ? new Promise<Reply>((resolve) => { release = () => resolve({}); }) : undefined);
        const run = engine.runFile('default', file, recordingReporter(), token());
        await settle();
        const before = world.commandsMatching(/dumpconfig/).length;
        const rediscovery = engine.discover();
        await settle();
        await settle();
        assert.strictEqual(world.commandsMatching(/dumpconfig/).length, before, 'no dumpconfig while the build runs');
        release();
        await Promise.all([run, rediscovery]);
        assert.strictEqual(world.commandsMatching(/dumpconfig/).length, before + 1);
    });

    test('builds in different directories may run at once', async () => {
        const world = new FakeCeedling();
        world.testFiles = ['test/test_calc.c'];
        for (const dir of ['a', 'b']) world.write(`${WS}/${dir}/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const held: Array<() => void> = [];
        world.handlers.push((command) => /^ceedling test:/.test(command) ? new Promise<Reply>((resolve) => { held.push(() => resolve({})); }) : undefined);
        const runs = projects.map((p) => engine.runFile(p.projectKey, p.files[0], recordingReporter(), token()));
        await settle();
        assert.deepStrictEqual(world.commands.filter((c) => /^ceedling test:/.test(c.command)).map((c) => c.cwd).sort(), [`${WS}/a`, `${WS}/b`]);
        held.forEach((release) => release());
        await Promise.all(runs);
    });

    // Many watcher events at once, e.g. from a branch checkout, must not exhaust file descriptors.
    test('reads stay within one shared limit across rediscoveries and reparses', async () => {
        const world = new FakeCeedling();
        world.testFiles = Array.from({ length: 40 }, (_, i) => `test/test_m${i}.c`);
        for (const file of world.testFiles) world.write(`${WS}/${file}`, 'void test_a(void) {}\n');
        const { engine } = await discovered(world);
        let open!: () => void;
        world.readGate = new Promise((resolve) => { open = resolve; });
        world.maxReadsInFlight = 0;
        const work = [engine.discover(), ...world.testFiles.map((file) => engine.rediscoverFile('default', file))];
        await settle();
        await settle();
        open();
        await Promise.all(work);
        assert.ok(world.maxReadsInFlight <= 16, `at most 16 reads at once, saw ${world.maxReadsInFlight}`);
        assert.ok(world.maxReadsInFlight > 1, 'reads still overlap');
    });

    test('test files are read at the same time, and keep their listed order', async () => {
        const world = new FakeCeedling();
        world.testFiles = ['test/test_calc.c', 'test/test_more.c'];
        world.write(`${WS}/test/test_more.c`, 'void test_more(void) {}\n');
        let open!: () => void;
        world.readGate = new Promise((resolve) => { open = resolve; });
        const discovery = makeEngine(world).discover();
        // eslint-disable-next-line no-await-in-loop -- polls until discovery reaches listing
        while (!world.commandsMatching(/files:test/).length) await settle();
        await settle();
        assert.deepStrictEqual(world.reads.filter((r) => r.includes('/test/')), [`${WS}/test/test_calc.c`, `${WS}/test/test_more.c`]);
        open();
        const [project] = await discovery;
        assert.deepStrictEqual(project.files.map((f) => f.id), ['test/test_calc.c', 'test/test_more.c']);
    });
});
