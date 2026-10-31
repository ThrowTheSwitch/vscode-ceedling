import * as assert from 'assert';
import type * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type vscode from 'vscode';
import { CeedlingEngine, coverageMode, type EngineFileSystem, nodeFileSystem } from '../../src/ceedlingEngine';
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
            listFiles: async (dir) => [...this.files.keys()].filter((f) => f.startsWith(`${dir}/`) || f.startsWith(`${dir}\\`)).sort(),
            unlink: async (p) => {
                if (this.undeletable.has(p)) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' });
                if (!this.files.delete(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
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

    // The CppUnit report a run would write to the project's artifacts: test/ for a test run,
    // gcov/ for a coverage run.
    reportWrite(xml: string, buildRoot = 'build', context = 'test'): Record<string, string> {
        return { [`${WS}/${buildRoot}/artifacts/${context}/cppunit_tests_report.xml`]: xml };
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
        coverage: (outcome) => calls.push(['coverage', outcome]),
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

function makeEngine(world: FakeCeedling, options: { settings?: Record<string, unknown>, logs?: LogCall[], problems?: FakeProblemMatcher, developmentMode?: boolean, folder?: string, platform?: NodeJS.Platform } = {}) {
    const settings = options.settings ?? {};
    const folder = options.folder ?? WS;
    return new CeedlingEngine(
        { uri: { fsPath: folder, toString: () => `file://${folder}` }, name: 'ws', index: 0 } as unknown as vscode.WorkspaceFolder,
        fakeLogger(options.logs),
        options.developmentMode ?? false,
        {
            configProvider: () => ({ get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback) }) as unknown as vscode.WorkspaceConfiguration,
            problemMatcher: (options.problems ?? new FakeProblemMatcher()) as unknown as ProblemMatcher,
            bundledMixinPath: BUNDLED_MIXIN,
            runner: world.runner,
            fileSystem: world.fileSystem,
            platform: options.platform ?? 'linux',
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

// `ceedling version` in a project directory that runs another installation, e.g. one vendored in
// vendor/ceedling: the launcher on the PATH and the application it hands off to.
function runsAnotherCeedling(world: FakeCeedling, stdout: string): void {
    world.handlers.push((command) => /^ceedling version/.test(command) ? { stdout } : undefined);
}
const versionFixture = (name: string) => fs.readFileSync(path.resolve(fixturesRoot, 'ceedling-1.2.1', name), 'utf8');
const launching = (launcher: string, application: string) =>
    `Welcome to Ceedling!\n\n  Ceedling Launcher => ${launcher}\n  ----------------------\n  /gems/ceedling-${launcher}/\n  \n` +
    `  Ceedling App => ${application}\n  ----------------------\n  ${WS}/vendor/ceedling/\n`;

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

    // A newer launcher reports the application's own release, so the application's decides.
    test('an unsupported Ceedling behind a supported launcher is a load error naming the application', async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, launching('1.2.2-0a1b2c3', '0.31.1'));
        await assert.rejects(makeEngine(world).discover(), (e: unknown) => e instanceof CeedlingLoadError && /version 0\.31\.1 is not supported/.test(e.message));
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

    test('a project with a copy of the same Ceedling in vendor/ceedling loads', async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, versionFixture('version-vendored-stdout.txt'));
        const logs: LogCall[] = [];
        const { file } = await discovered(world, { logs });
        assert.strictEqual(file.id, 'test/test_calc.c');
        assert.deepStrictEqual(logs.filter((l) => l.level === 'warn'), []);
    });

    // A 1.1.10 application writes its configuration only to a file, whatever the launcher.
    test("from Ceedling 1.2.2, a project with another Ceedling in vendor/ceedling runs at that Ceedling's release", async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, launching('1.2.2-0a1b2c3', '1.1.10-85ec551'));
        const logs: LogCall[] = [];
        await discovered(world, { logs });
        assert.deepStrictEqual(world.commandsMatching(/^ceedling dumpconfig --stdout/), []);
        assert.strictEqual(world.commandsMatching(/^ceedling dumpconfig \S+\.yml/).length, 1);
        assert.deepStrictEqual(logs.filter((l) => l.level === 'warn'), []);
    });

    // From 1.2.2 `ceedling version` reads the project file and takes mixins, so a selection made in
    // an alternate project file or a mixin shows. Older launchers reject both options.
    test("from Ceedling 1.2.2, the version check is given a project's mixins, and reports what they select", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        world.handlers.push((command) => /^ceedling version --project/.test(command) ? { stdout: launching('1.2.2', '1.1.10-85ec551') } : undefined);
        await discovered(world, { settings: { projects: [{ path: '.', debugLaunchConfig: 'dbg', mixins: ['mixins/which.yml'] }] } });
        assert.deepStrictEqual(world.commandsMatching(/^ceedling version/), ['ceedling version', `ceedling version --project project.yml --mixin mixins/which.yml --mixin ${BUNDLED_MIXIN}`]);
        assert.strictEqual(world.commandsMatching(/^ceedling dumpconfig \S+\.yml/).length, 1, "1.1.10's dumpconfig writes a file");
    });

    test('before Ceedling 1.2.2, the version check is never given project arguments', async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        await discovered(world, { settings: { projects: [{ path: '.', debugLaunchConfig: 'dbg', mixins: ['mixins/which.yml'] }] } });
        assert.deepStrictEqual(world.commandsMatching(/^ceedling version/), ['ceedling version']);
    });

    // A bare check reads whichever default project file Ceedling prefers, or CEEDLING_PROJECT_FILE.
    test("from Ceedling 1.2.2, every project checks its version again with its own project file", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        await discovered(world);
        assert.deepStrictEqual(world.commandsMatching(/^ceedling version/), ['ceedling version', `ceedling version ${PROJECT_ARGS}`]);
    });

    // The launcher, not the application it hands off to, decides which options `version` takes.
    test('a launcher before 1.2.2 running a newer application is never given project arguments', async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, launching('1.2.1-47d2c5e', '1.2.2-0a1b2c3'));
        await discovered(world, { settings: { projects: [{ path: '.', debugLaunchConfig: 'dbg', mixins: ['mixins/which.yml'] }] } });
        assert.deepStrictEqual(world.commandsMatching(/^ceedling version/), ['ceedling version']);
    });

    // From 1.2.2 `ceedling version` loads the configuration, so a missing mixin or a bad
    // :which_ceedling: path stops it. That is the project's problem, not a missing Ceedling.
    test("from Ceedling 1.2.2, a version check stopped by a project's configuration is that project's load error alone", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        world.handlers.push((command, cwd) => /^ceedling version --project/.test(command) && cwd.endsWith('/a')
            ? { error: true, stderr: 'EXCEPTION: Configured Ceedling launch path /opt/nowhere/ does not exist\n' } : undefined);
        const settings = { projects: [{ path: 'a', debugLaunchConfig: 'dbg' }, { path: 'b', debugLaunchConfig: 'dbg' }] };
        for (const dir of ['a', 'b']) {
            world.directories.add(`${WS}/${dir}`);
            world.write(`${WS}/${dir}/project.yml`, ':project: {}\n');
        }
        world.handlers.push((command, cwd) => /^ceedling dumpconfig/.test(command) && cwd.endsWith('/b') ? { error: true, stderr: 'EXCEPTION: bad b\n' } : undefined);
        await assert.rejects(makeEngine(world, { settings }).discover(), (e: unknown) => e instanceof CeedlingLoadError &&
            /project 'a'/.test(e.message) && e.message.includes('EXCEPTION: Configured Ceedling launch path /opt/nowhere/ does not exist') &&
            !/installed/.test(e.message) && e.message.includes('EXCEPTION: bad b'));
    });

    // Before 1.2.2 a launcher reports another installation as its own release, with that
    // installation's commit (Ceedling#1365), so the application's release is unknown.
    test("before Ceedling 1.2.2, a project with another build in vendor/ceedling runs at the launcher's release, with a warning", async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, versionFixture('version-vendored-1.2.0-stdout.txt'));
        const logs: LogCall[] = [];
        await discovered(world, { logs });
        assert.strictEqual(world.commandsMatching(/^ceedling dumpconfig --stdout/).length, 1);
        const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /'default' runs Ceedling 1\.2\.1-13a540f.*can't tell its release.*1\.2\.1.*Ceedling 1\.2\.2/s);
    });

    test('dumpconfig output that is not YAML is a load error, with the parse error logged', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = ':plugins: [unclosed\n';
        const logs: LogCall[] = [];
        await assert.rejects(makeEngine(world, { logs }).discover(), (e: unknown) => e instanceof CeedlingLoadError && /dumpconfig/.test(e.message));
        assert.ok(logs.some((l) => l.level === 'error' && /could not parse dumpconfig output/.test(l.message)));
    });

    test('a failed test listing is a load error naming the project and the settings to check, with the failure logged', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^ceedling files:test/.test(command) ? { error: true, stderr: 'boom' } : undefined);
        const logs: LogCall[] = [];
        await assert.rejects(makeEngine(world, { logs }).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && /'default'/.test(e.message) && /files:test/.test(e.message) && /shellPath/.test(e.message));
        assert.ok(logs.some((l) => l.level === 'error' && /files:test/.test(l.message)));
    });

    test('a failed test listing keeps the last good projects for runs and watchers', async () => {
        const world = new FakeCeedling();
        const { engine } = await discovered(world);
        world.handlers.push((command) => /^ceedling files:test/.test(command) ? { error: true } : undefined);
        await assert.rejects(engine.discover(), CeedlingLoadError);
        assert.deepStrictEqual(engine.testFileAt(`${WS}/test/test_calc.c`), { projectKey: 'default', fileId: 'test/test_calc.c' });
    });

    test('every project whose listing failed is named, in settings order', async () => {
        const world = new FakeCeedling();
        for (const dir of ['a', 'b', 'c']) {
            world.directories.add(`${WS}/${dir}`);
            world.write(`${WS}/${dir}/project.yml`, ':project: {}\n');
        }
        world.handlers.push((command, cwd) => /^ceedling files:test/.test(command) && cwd !== `${WS}/b` ? { error: true } : undefined);
        const settings = { projects: ['a', 'b', 'c'].map((dir) => ({ path: dir, debugLaunchConfig: 'dbg' })) };
        await assert.rejects(makeEngine(world, { settings }).discover(), (e: unknown) => e instanceof CeedlingLoadError &&
            /'a'[\s\S]*'c'/.test(e.message) && !/'b'/.test(e.message));
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

    // Ceedling's own exception says what went wrong, e.g. that it can't run a selected installation.
    test("a failed dumpconfig's load error quotes Ceedling's exception", async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^ceedling dumpconfig/.test(command)
            ? { error: true, stderr: "🧨 EXCEPTION: undefined method `cp_r_with_retry' for an instance of FileWrapper\n" } : undefined);
        await assert.rejects(makeEngine(world).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && e.message.includes("EXCEPTION: undefined method `cp_r_with_retry' for an instance of FileWrapper"));
    });

    test("a failed test listing's load error quotes Ceedling's exception", async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^ceedling files:test/.test(command) ? { error: true, stdout: "EXCEPTION: Failed to construct 'rake_wrapper'\n" } : undefined);
        await assert.rejects(makeEngine(world).discover(),
            (e: unknown) => e instanceof CeedlingLoadError && e.message.includes("EXCEPTION: Failed to construct 'rake_wrapper'"));
    });

    test("a failed dumpconfig leaves no temporary file, even one Ceedling wrote", async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        world.handlers.push((command) => {
            const dump = /^ceedling dumpconfig (\S+)/.exec(command);
            return dump ? { error: true, writes: { [dump[1]]: 'partial' } } : undefined;
        });
        await assert.rejects(makeEngine(world).discover(), CeedlingLoadError);
        assert.deepStrictEqual([...world.files.keys()].filter((f) => f.includes('ceedling-dumpconfig')), []);
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
        assert.deepStrictEqual((await engine.configurationFiles()).sort(), [`${WS}/fw/ceedling.yml`, `${WS}/fw/ci.yml`, `${WS}/fw/project.yml`, `${WS}/fw/vendor/ceedling/lib/version.rb`]);
    });

    // 1.2.0 nests each executable under its test file's directory, relative to the test path.
    test("a nested test file's executable is found under its directory", async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = `:paths:\n  :test:\n    - "+:test/**"\n${world.resolvedConfig}`;
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

    // The longest test path holding a file decides its build directory, not which build is newest.
    test("a test file's executable follows its own test path, even beside a newer same-named one", async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = `:paths:\n  :test:\n    - "+:test/unit/**"\n    - "+:extra/**"\n${world.resolvedConfig}`;
        world.testFiles = ['test/unit/test_calc.c', 'extra/unit/test_calc.c'];
        for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? {
            writes: {
                ...world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add'] })),
                [`${WS}/build/test/out/test_calc/test_calc.out`]: 'ELF',
                [`${WS}/build/test/out/unit/test_calc/test_calc.out`]: 'ELF, written last',
            },
        } : undefined);
        const file = projects[0].files.find((f) => f.id === 'test/unit/test_calc.c')!;
        assert.strictEqual(await engine.compileForDebug('default', file, recordingReporter(), token()), 'test_calc/test_calc.out');
    });

    test("before Ceedling 1.2.0, a nested test file's executable builds under its bare name", async () => {
        const world = new FakeCeedling();
        world.version = '1.1.10';
        world.resolvedConfig = `:paths:\n  :test:\n    - "+:test/**"\n${world.resolvedConfig}`;
        world.testFiles = ['test/unit/test_calc.c'];
        world.write(`${WS}/test/unit/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { writes: world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add'] })) } : undefined);
        assert.strictEqual(await engine.compileForDebug('default', file, recordingReporter(), token()), 'test_calc/test_calc.out');
    });

    // A debug build of test/unit/test_calc.c under `+:test/**`, writing the executables `built`.
    // `misreported` runs it behind a launcher before 1.2.2 that reports 1.2.1 for another build, so
    // its release isn't exact. `namesake` adds test/test_calc.c, which builds as test_calc in 1.2.1.
    async function debugBuild(world: FakeCeedling, built: string[], options: { logs?: LogCall[], misreported?: boolean, namesake?: boolean, selects?: string } = {}): Promise<string | undefined> {
        if (options.misreported) runsAnotherCeedling(world, launching('1.2.1-47d2c5e', '1.2.1-13a540f'));
        const selecting = options.selects === undefined ? '' : `:project:\n  :which_ceedling: ${options.selects}\n`;
        world.resolvedConfig = `${selecting}:paths:\n  :test:\n    - "+:test/**"\n${world.resolvedConfig}`;
        world.testFiles = options.namesake ? ['test/test_calc.c', 'test/unit/test_calc.c'] : ['test/unit/test_calc.c'];
        world.write(`${WS}/test/unit/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { logs: options.logs });
        world.handlers.push((command) => /^ceedling test:/.test(command) ? {
            writes: {
                ...world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add'] })),
                ...Object.fromEntries(built.map((executable) => [`${WS}/build/test/out/${executable}`, 'ELF'])),
            },
        } : undefined);
        return engine.compileForDebug('default', projects[0].files.find((f) => f.id === 'test/unit/test_calc.c')!, recordingReporter(), token());
    }
    const OWN_121 = 'unit/test_calc/test_calc.out', OWN_122 = 'test/unit/test_calc/test_calc.out';

    // 1.2.2 names a test by its path from the project root, test root and all.
    test("from Ceedling 1.2.2, a test file's executable is found under its path from the project root", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        assert.strictEqual(await debugBuild(world, [OWN_122]), OWN_122);
    });

    // A release known exactly says where its build goes, and another layout's path may be another test's.
    test('a release known exactly finds its executable in its own layout alone', async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        const logs: LogCall[] = [];
        assert.strictEqual(await debugBuild(world, [OWN_122], { logs }), OWN_121);
        assert.ok(logs.some((l) => l.level === 'warn' && /no built executable/.test(l.message)));
    });

    // A launcher before 1.2.2 reports its own release for another build (Ceedling#1365), so that
    // build may be a 1.2.2 laying its executable out from the project root.
    test("with a misreported release, an executable the build wrote in another layout is found there, with a note in the log", async () => {
        const world = new FakeCeedling();
        world.write(`${WS}/build/test/out/${OWN_121}`, 'ELF, an older build');
        const logs: LogCall[] = [];
        assert.strictEqual(await debugBuild(world, [OWN_122], { logs, misreported: true }), OWN_122);
        assert.ok(logs.some((l) => l.level === 'warn' && l.message.includes(OWN_122)), 'the other layout is logged');
    });

    // Before 1.2.2 `ceedling version` never reads :which_ceedling:, so it reports the launcher's own release.
    test('a release the version check reported for another selected installation counts as misreported', async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        assert.strictEqual(await debugBuild(world, [OWN_122], { selects: 'tools/ceedling' }), OWN_122);
    });

    // From 1.2.2 the version check reads :which_ceedling:, so it reports the installation selected.
    test('from Ceedling 1.2.2, a release the version check reported for a selected installation is known', async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, launching('1.2.2', '1.2.1-47d2c5e'));
        assert.strictEqual(await debugBuild(world, [OWN_122], { selects: 'tools/ceedling' }), OWN_121);
    });

    test('with a misreported release, an executable the build rewrote in its own layout is found there, with no note', async () => {
        const world = new FakeCeedling();
        world.write(`${WS}/build/test/out/${OWN_122}`, 'ELF, an older build');
        world.write(`${WS}/build/test/out/${OWN_121}`, 'ELF');
        const logs: LogCall[] = [];
        assert.strictEqual(await debugBuild(world, [OWN_121], { logs, misreported: true }), OWN_121);
        assert.deepStrictEqual(logs.filter((l) => l.level === 'warn' && l.message.startsWith('executableSubpath')), []);
    });

    // A delta build leaves an up-to-date executable as it was, so none is new. The newest is the
    // build's, and an older layout's copy predates it.
    test('with a misreported release and no executable written, the newest that exists is found', async () => {
        const world = new FakeCeedling();
        world.write(`${WS}/build/test/out/${OWN_121}`, 'ELF, an older layout');
        world.write(`${WS}/build/test/out/${OWN_122}`, 'ELF');
        assert.strictEqual(await debugBuild(world, [], { misreported: true }), OWN_122);
    });

    // In 1.2.1's flat layout, test/unit/test_calc.c would build as test_calc, test/test_calc.c's own name.
    test("with a misreported release, a same-named test's executable is never found instead", async () => {
        const world = new FakeCeedling();
        world.write(`${WS}/test/test_calc.c`, 'void test_add(void) {}\n');
        assert.strictEqual(await debugBuild(world, ['test_calc/test_calc.out'], { misreported: true, namesake: true }), OWN_121);
    });

    test("with no executable anywhere, the path is the release's own, and the miss is logged", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        const logs: LogCall[] = [];
        assert.strictEqual(await debugBuild(world, [], { logs }), OWN_122);
        assert.ok(logs.some((l) => l.level === 'warn' && /no built executable/.test(l.message)));
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

    // The Testing view shows a message's first line. Without this, that line reads "stdout:".
    const STOPPED = 'Building...\n🧨 EXCEPTION: Ambiguous file reference \'test_calc.c\' found.\n🌱 Ceedling could not complete operations because of errors\n';

    test("with no report and no diagnostic, Ceedling's exception leads every id's message", async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { error: true, stdout: 'OUT', stderr: STOPPED } : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        const errored = reporter.of('errored');
        assert.strictEqual(errored.length, 6);
        assert.ok(errored.every((call) => String(call[2]).startsWith("EXCEPTION: Ambiguous file reference 'test_calc.c' found.\n\nstdout:\nOUT\nstderr:\nBuilding...")));
        assert.strictEqual(errored[0][3], undefined);
    });

    test("with no report, the most severe diagnostic leads, then Ceedling's exception, then the transcript", async () => {
        const world = new FakeCeedling();
        const problems = new FakeProblemMatcher();
        problems.matches = [diagnostic('/ws/test/test_calc.c', 7, 0, 'the error')];
        const { engine, file } = await discovered(world, { problems });
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { error: true, stderr: STOPPED } : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token());
        assert.match(String(reporter.of('errored')[0][2]), /^the error\n\nEXCEPTION: Ambiguous file reference 'test_calc.c' found\.\n\nstderr:\nBuilding/);
    });

    test("a debug build that stops leads its errors with Ceedling's exception", async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { error: true, stderr: STOPPED } : undefined);
        const reporter = recordingReporter();
        assert.strictEqual(await engine.compileForDebug('default', file, reporter, token()), undefined);
        assert.match(String(reporter.of('errored')[0][2]), /^EXCEPTION: Ambiguous file reference/);
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

    // The user asked it to stop, so stopping is no failure to report.
    test('a cancelled clean is not a failure', async () => {
        const world = new FakeCeedling();
        const { engine } = await discovered(world);
        const cancel = token();
        world.handlers.push((command) => /^ceedling clean/.test(command)
            ? new Promise<Reply>((resolve) => setImmediate(() => { cancel.fire(); resolve({ error: true }); }))
            : undefined);
        assert.strictEqual(await engine.clean(cancel), true);
        assert.strictEqual(world.killed.length, 1);
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
        assert.deepStrictEqual((await engine.configurationFiles()).sort(),
            [`${WS}/fw/ceedling.yml`, `${WS}/fw/mixins/cov.yml`, `${WS}/fw/project.yml`, `${WS}/fw/vendor/ceedling/lib/version.rb`]);
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

    // VS Code reports `c:\…` paths, while discovery uppercases the drive letter for gcov.
    test('on Windows, a discovered test file is found whatever the case of its path', async () => {
        const world = new FakeCeedling();
        world.write('C:\\ws\\project.yml', ':project: {}\n');
        world.write('C:\\ws\\test\\test_calc.c', 'void test_add(void) {}\n');
        const engine = makeEngine(world, { folder: 'c:\\ws', platform: 'win32' });
        const [project] = await engine.discover();
        assert.strictEqual(project.files[0].absPath, 'C:\\ws\\test\\test_calc.c');
        assert.deepStrictEqual(engine.testFileAt('c:\\ws\\test\\test_calc.c'), { projectKey: 'default', fileId: 'test/test_calc.c' });
        assert.deepStrictEqual(engine.testFileAt('C:\\WS\\Test\\TEST_CALC.c'), { projectKey: 'default', fileId: 'test/test_calc.c' });
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

    test('every file beneath a directory is listed, at any depth, and a missing directory lists nothing', async () => {
        fs.mkdirSync(path.join(folder, 'out', 'test_a'), { recursive: true });
        fs.writeFileSync(path.join(folder, 'out', 'top.gcda'), '');
        fs.writeFileSync(path.join(folder, 'out', 'test_a', 'a.gcda'), '');
        assert.deepStrictEqual(await nodeFileSystem.listFiles(path.join(folder, 'out')),
            [path.join(folder, 'out', 'test_a', 'a.gcda'), path.join(folder, 'out', 'top.gcda')]);
        assert.deepStrictEqual(await nodeFileSystem.listFiles(path.join(folder, 'missing')), []);
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
    // Long enough for work the locks don't hold back to start Ceedling.
    const settled = () => settle().then(settle).then(settle).then(settle);
    // Whether a promise has settled, readable without awaiting it.
    function finished(promise: Promise<unknown>): { done: boolean } {
        const state = { done: false };
        void promise.finally(() => { state.done = true; });
        return state;
    }
    // Holds each matching Ceedling command until released, then gives its reply.
    function held(world: FakeCeedling, command: RegExp, reply: Reply = {}) {
        const releases: Array<() => void> = [];
        world.handlers.push((line) => command.test(line) ? new Promise<Reply>((resolve) => { releases.push(() => resolve(reply)); }) : undefined);
        return {
            release: () => releases.splice(0).forEach((release) => release()),
            releaseFirst: () => releases.shift()?.(),
        };
    }
    // Discovery's commands so far in a project directory, the folder itself by default.
    const discoveryCommands = (world: FakeCeedling, directory = '', kind = /dumpconfig|files:test/) =>
        world.commands.filter((c) => kind.test(c.command) && c.cwd === `${WS}${directory && `/${directory}`}`).length;

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

    // Before Ceedling 1.2.1, every command that loads a project rewrites the Unity copy in its build
    // directory, so a configuration check during a build in the same directory could corrupt it.
    test("before Ceedling 1.2.1, a rediscovery's configuration check waits for a build in the same directory", async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('default', file, recordingReporter(), token());
        await settle();
        const before = discoveryCommands(world, '', /dumpconfig/);
        const rediscovery = engine.discover();
        await settled();
        assert.strictEqual(discoveryCommands(world, '', /dumpconfig/), before, 'no dumpconfig while the build runs');
        build.release();
        await Promise.all([run, rediscovery]);
        assert.strictEqual(discoveryCommands(world, '', /dumpconfig/), before + 1);
    });

    test('builds in different directories may run at once', async () => {
        const world = new FakeCeedling();
        world.testFiles = ['test/test_calc.c'];
        for (const dir of ['a', 'b']) world.write(`${WS}/${dir}/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const builds = held(world, /^ceedling test:/);
        const runs = projects.map((p) => engine.runFile(p.projectKey, p.files[0], recordingReporter(), token()));
        await settle();
        assert.deepStrictEqual(world.commands.filter((c) => /^ceedling test:/.test(c.command)).map((c) => c.cwd).sort(), [`${WS}/a`, `${WS}/b`]);
        builds.release();
        await Promise.all(runs);
    });

    // A build's files and its report live under its build root, not its project directory, so
    // projects sharing one, e.g. through a common mixin, would read each other's reports.
    test('builds in different directories sharing a build root run one after the other', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = `:project:\n  :build_root: ../build\n${world.resolvedConfig}`;
        for (const dir of ['a', 'b']) world.write(`${WS}/${dir}/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const builds = held(world, /^ceedling test:/);
        const runs = projects.map((p) => engine.runFile(p.projectKey, p.files[0], recordingReporter(), token()));
        await settle();
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 1, 'one build at a time in the shared build root');
        builds.releaseFirst();
        await settled();
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 2);
        builds.release();
        await Promise.all(runs);
    });

    test("before Ceedling 1.2.1, a rediscovery's configuration check waits for a build in another directory sharing its build root", async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = `:project:\n  :build_root: /shared/build\n${world.resolvedConfig}`;
        world.write(`${WS}/a/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('a', projects[0].files[0], recordingReporter(), token());
        await settle();
        const before = discoveryCommands(world, 'b', /dumpconfig/);
        const rediscovery = engine.discover();
        await settled();
        assert.strictEqual(discoveryCommands(world, 'b', /dumpconfig/), before, "no dumpconfig in b while a's build runs");
        build.release();
        await Promise.all([run, rediscovery]);
        assert.strictEqual(discoveryCommands(world, 'b', /dumpconfig/), before + 1);
    });

    // From Ceedling 1.2.1, dumpconfig and files:test write nothing, so a rediscovery needn't wait out
    // a run.
    // The discovery commands a rediscovery runs while a build of the first project's first file
    // holds. `change` runs after the first discovery, before the build starts.
    async function discoveryDuringBuild(world: FakeCeedling, options: { settings?: Record<string, unknown>, change?: () => void } = {}): Promise<{ dumpconfig: number, filesTest: number }> {
        const { engine, projects: [project] } = await discovered(world, { settings: options.settings });
        options.change?.();
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile(project.projectKey, project.files[0], recordingReporter(), token());
        await settle();
        const count = () => ({ dumpconfig: discoveryCommands(world, '', /dumpconfig/), filesTest: discoveryCommands(world, '', /files:test/) });
        const before = count();
        const rediscovery = engine.discover();
        await settled();
        const after = count();
        build.release();
        await Promise.all([run, rediscovery]);
        return { dumpconfig: after.dumpconfig - before.dumpconfig, filesTest: after.filesTest - before.filesTest };
    }
    const BOTH = { dumpconfig: 1, filesTest: 1 }, NEITHER = { dumpconfig: 0, filesTest: 0 };

    test("on Ceedling 1.2.1, a rediscovery doesn't wait for a build in the same directory", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        const { engine, file } = await discovered(world);
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('default', file, recordingReporter(), token());
        await settle();
        const before = discoveryCommands(world);
        const rediscovery = engine.discover();
        await settled();
        assert.strictEqual(discoveryCommands(world), before + 2, 'dumpconfig and files:test during the build');
        assert.deepStrictEqual((await rediscovery)[0]?.files.map((f) => f.id), [file.id]);
        build.release();
        await run;
    });

    test("on Ceedling 1.2.1, rediscoveries wait for no build, in their own directory or another sharing their build root", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        world.resolvedConfig = `:project:\n  :build_root: /shared/build\n${world.resolvedConfig}`;
        world.write(`${WS}/a/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('a', projects[0].files[0], recordingReporter(), token());
        await settle();
        const before = { a: discoveryCommands(world, 'a'), b: discoveryCommands(world, 'b') };
        const rediscovery = engine.discover();
        await settled();
        assert.deepStrictEqual({ a: discoveryCommands(world, 'a'), b: discoveryCommands(world, 'b') }, { a: before.a + 2, b: before.b + 2 });
        build.release();
        await Promise.all([run, rediscovery]);
    });

    test("on Ceedling 1.2.1, a rediscovery doesn't wait for a clean", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        const { engine } = await discovered(world);
        const clean = held(world, /^ceedling clean/);
        const cleaning = engine.clean();
        await settle();
        const before = discoveryCommands(world);
        const rediscovery = engine.discover();
        await settled();
        assert.strictEqual(discoveryCommands(world), before + 2);
        clean.release();
        await Promise.all([cleaning, rediscovery]);
    });

    // The gate is the discovering project's own Ceedling, whose commands are the ones that write.
    test("a project on Ceedling 1.2.0 still waits for a 1.2.1 project's build sharing its build root", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        world.handlers.push((command, cwd) => /^ceedling version/.test(command) && cwd === `${WS}/b` ? { stdout: 'Ceedling => 1.2.0\n' } : undefined);
        world.resolvedConfig = `:project:\n  :build_root: /shared/build\n${world.resolvedConfig}`;
        world.write(`${WS}/a/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('a', projects[0].files[0], recordingReporter(), token());
        await settle();
        const before = { a: discoveryCommands(world, 'a'), b: discoveryCommands(world, 'b') };
        const rediscovery = engine.discover();
        await settled();
        assert.deepStrictEqual({ a: discoveryCommands(world, 'a'), b: discoveryCommands(world, 'b') }, { a: before.a + 1, b: before.b }, "a's dumpconfig runs, b's waits");
        build.release();
        await Promise.all([run, rediscovery]);
        assert.strictEqual(discoveryCommands(world, 'b'), before.b + 2);
    });

    // Each discovery gates on the version it just checked, not the one the last discovery found.
    for (const [from, to, waits] of [['1.2.0', '1.2.1', false], ['1.2.1', '1.2.0', true]] as const) {
        test(`a rediscovery after Ceedling changes from ${from} to ${to} ${waits ? 'waits' : "doesn't wait"} for a build`, async () => {
            const world = new FakeCeedling();
            world.version = from;
            const { engine, file } = await discovered(world);
            world.version = to;
            const build = held(world, /^ceedling test:/);
            const run = engine.runFile('default', file, recordingReporter(), token());
            await settle();
            const before = discoveryCommands(world);
            const rediscovery = engine.discover();
            await settled();
            assert.strictEqual(discoveryCommands(world), before + (waits ? 0 : 2));
            build.release();
            await Promise.all([run, rediscovery]);
        });
    }

    // Before 1.2.2, `ceedling version` never loads the project file, so it reports the launcher's
    // version, not the one a project's :which_ceedling: selects for every other command.
    test("on Ceedling 1.2.1, a project whose configuration selects another Ceedling still waits for a build", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        world.resolvedConfig = `:project:\n  :which_ceedling: tools/ceedling\n${world.resolvedConfig}`;
        assert.deepStrictEqual(await discoveryDuringBuild(world), NEITHER);
    });

    // `ceedling version` in the project directory finds vendor/ceedling itself, the installation
    // `ceedling new --local` vendors and names in :which_ceedling:. Ceedling reads `gem` in any case.
    for (const which of ['vendor/ceedling', "'./vendor/ceedling/'", `${WS}/vendor/ceedling`, "' Gem '"]) {
        test(`on Ceedling 1.2.1, a project selecting ${which} with :which_ceedling: doesn't wait for a build`, async () => {
            const world = new FakeCeedling();
            world.version = '1.2.1';
            if (which.includes('vendor')) runsAnotherCeedling(world, versionFixture('version-vendored-stdout.txt'));
            world.resolvedConfig = `:project:\n  :which_ceedling: ${which}\n${world.resolvedConfig}`;
            assert.deepStrictEqual(await discoveryDuringBuild(world), BOTH);
        });
    }

    // From 1.2.2 the version check reads the configuration this discovery's dumpconfig runs with.
    test("from Ceedling 1.2.2, a project whose configuration selects another 1.2.1 doesn't wait for a build", async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, launching('1.2.2', '1.2.1-47d2c5e'));
        world.resolvedConfig = `:project:\n  :which_ceedling: tools/ceedling\n${world.resolvedConfig}`;
        assert.deepStrictEqual(await discoveryDuringBuild(world), BOTH);
    });

    test("from Ceedling 1.2.2, a rediscovery after a change to its project file doesn't wait for a build", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        assert.deepStrictEqual(await discoveryDuringBuild(world, { change: () => world.write(`${WS}/project.yml`, ':project:\n  :build_root: build\n') }), BOTH);
    });

    // The last discovery's configuration stands for a rediscovery's dumpconfig only while the files it
    // came from are unchanged. An edit may have just selected another Ceedling, which `version` can't
    // see before 1.2.2.
    type Settings = { projects: Array<{ path: string, debugLaunchConfig: string, mixins: string[] }> };
    const changes: Array<[string, (world: FakeCeedling, settings: Settings) => void]> = [
        ['its project file', (world) => world.write(`${WS}/project.yml`, ':project:\n  :which_ceedling: tools/ceedling\n')],
        ['a mixin file', (world) => world.write(`${WS}/mixins/extra.yml`, ':project:\n  :which_ceedling: tools/ceedling\n')],
        ['its mixins setting', (_world, settings) => { settings.projects[0].mixins = ['mixins/extra.yml', 'gcc']; }],
    ];
    for (const [what, change] of changes) {
        test(`on Ceedling 1.2.1, a rediscovery after a change to ${what} waits for a build`, async () => {
            const world = new FakeCeedling();
            world.version = '1.2.1';
            world.write(`${WS}/mixins/extra.yml`, ':project: {}\n');
            const settings: Settings = { projects: [{ path: '.', debugLaunchConfig: 'dbg', mixins: ['mixins/extra.yml'] }] };
            assert.deepStrictEqual(await discoveryDuringBuild(world, { settings, change: () => change(world, settings) }), NEITHER);
        });
    }

    // Listing gates on the configuration this discovery just resolved, not the last one.
    test('on Ceedling 1.2.1, a rediscovery whose dumpconfig newly selects another Ceedling lists after the build', async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        const selected = `:project:\n  :which_ceedling: tools/ceedling\n${world.resolvedConfig}`;
        assert.deepStrictEqual(await discoveryDuringBuild(world, { change: () => { world.resolvedConfig = selected; } }), { dumpconfig: 1, filesTest: 0 });
    });

    // A vendored Ceedling is one `ceedling version` sees, since it runs in the project directory.
    // The same commit shows the same build, so its release is known.
    test("on Ceedling 1.2.1, a project with a copy of the same build in vendor/ceedling doesn't wait for a build", async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, versionFixture('version-vendored-stdout.txt'));
        assert.deepStrictEqual(await discoveryDuringBuild(world), BOTH);
    });

    // The vendored Ceedling may predate 1.2.1, whose discovery rewrites the build root's sources.
    test('on Ceedling 1.2.1, a project with another build in vendor/ceedling waits for a build', async () => {
        const world = new FakeCeedling();
        runsAnotherCeedling(world, versionFixture('version-vendored-1.2.0-stdout.txt'));
        assert.deepStrictEqual(await discoveryDuringBuild(world), NEITHER);
    });

    for (const [application, waits] of [['1.2.1-13a540f', false], ['1.2.0-13a540f', true]] as const) {
        test(`from Ceedling 1.2.2, a project with Ceedling ${application} in vendor/ceedling ${waits ? 'waits' : "doesn't wait"} for a build`, async () => {
            const world = new FakeCeedling();
            runsAnotherCeedling(world, launching('1.2.2-0a1b2c3', application));
            assert.deepStrictEqual(await discoveryDuringBuild(world), waits ? NEITHER : BOTH);
        });
    }

    // Until a project's configuration shows it runs the Ceedling `version` checked, its dumpconfig
    // takes the locks.
    test("on Ceedling 1.2.1, a project's first dumpconfig waits for a build in its directory", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        const [ci, other] = twoProjects(world, 'fw/ci.yml', 'fw/other.yml').projects;
        world.write(`${WS}/fw/test/test_calc.c`, 'void test_add(void) {}\n');
        const settings = { projects: [ci] };
        const { engine, projects } = await discovered(world, { settings });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile(projects[0].projectKey, projects[0].files[0], recordingReporter(), token());
        await settle();
        settings.projects = [ci, other];
        const othersDumpconfig = () => world.commandsMatching(/^ceedling dumpconfig.*other\.yml/).length;
        const rediscovery = engine.discover();
        await settled();
        assert.strictEqual(othersDumpconfig(), 0, "the new project's dumpconfig waits for the build");
        build.release();
        await Promise.all([run, rediscovery]);
        assert.strictEqual(othersDumpconfig(), 1);
    });

    test("from Ceedling 1.2.2, a project's first dumpconfig doesn't wait for a build in its directory", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.2';
        const [ci, other] = twoProjects(world, 'fw/ci.yml', 'fw/other.yml').projects;
        world.write(`${WS}/fw/test/test_calc.c`, 'void test_add(void) {}\n');
        const settings = { projects: [ci] };
        const { engine, projects } = await discovered(world, { settings });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile(projects[0].projectKey, projects[0].files[0], recordingReporter(), token());
        await settle();
        settings.projects = [ci, other];
        const rediscovery = engine.discover();
        await settled();
        assert.strictEqual(world.commandsMatching(/^ceedling dumpconfig.*other\.yml/).length, 1, "the new project's dumpconfig runs during the build");
        build.release();
        await Promise.all([run, rediscovery]);
    });

    // dumpconfig and files:test each take the locks before 1.2.1. A build queued while dumpconfig
    // runs takes them next, so files:test waits for it.
    test("before Ceedling 1.2.1, a rediscovery's listing waits for a build that queued during its dumpconfig", async () => {
        const world = new FakeCeedling();
        const { engine, file } = await discovered(world);
        const dumpconfig = held(world, /^ceedling dumpconfig/, { stdout: world.resolvedConfig });
        const rediscovery = engine.discover();
        await settled();
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('default', file, recordingReporter(), token());
        const before = discoveryCommands(world, '', /files:test/);
        dumpconfig.release();
        await settled();
        assert.strictEqual(world.commandsMatching(/^ceedling test:/).length, 1, 'the build runs');
        assert.strictEqual(discoveryCommands(world, '', /files:test/), before, 'no files:test while the build runs');
        build.release();
        await Promise.all([run, rediscovery]);
        assert.strictEqual(discoveryCommands(world, '', /files:test/), before + 1);
    });

    // A rediscovery can finish while a build runs, so the build's results may land after the tree moved on.
    test("on Ceedling 1.2.1, a build that ends after a rediscovery dropped its file keeps no diagnostics for it", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        const problems = new FakeProblemMatcher();
        problems.matches = [diagnostic(`${WS}/test/test_calc.c`, 1, 0, 'the error')];
        const { engine, file } = await discovered(world, { problems });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('default', file, recordingReporter(), token());
        await settle();
        world.testFiles = [];
        const rediscovered = finished(engine.discover());
        await settled();
        assert.ok(rediscovered.done, 'the rediscovery finishes while the build runs');
        build.release();
        await run;
        assert.deepStrictEqual([...problems.entries.keys()].filter((id) => id.includes('test_calc')), []);
    });

    test("on Ceedling 1.2.1, a function run's whole-file fallback runs though a rediscovery dropped its project", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        world.write(`${WS}/a/test/test_calc.c`, 'void test_add(void) {}\nvoid test_add_more(void) {}\n');
        const settings = twoProjects(world, 'a', 'b');
        const { engine, projects } = await discovered(world, { settings });
        const filtered = held(world, /--test-case/, { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_add_more'] }), 'a/build') });
        const file = projects[0].files[0];
        const run = engine.runFunction('a', file, file.functions[0], recordingReporter(), token());
        await settle();
        settings.projects = settings.projects.slice(1);
        const rediscovered = finished(engine.discover());
        await settled();
        assert.ok(rediscovered.done, 'the rediscovery finishes while the filtered run builds');
        filtered.release();
        await run;
        assert.strictEqual(world.commands.filter((c) => /^ceedling test:/.test(c.command) && c.cwd === `${WS}/a`).length, 2);
    });

    test('clean waits for a build in another directory sharing its build root', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = `:project:\n  :build_root: /shared/build\n${world.resolvedConfig}`;
        world.write(`${WS}/a/test/test_calc.c`, 'void test_add(void) {}\n');
        const { engine, projects } = await discovered(world, { settings: twoProjects(world, 'a', 'b') });
        const build = held(world, /^ceedling test:/);
        const run = engine.runFile('a', projects[0].files[0], recordingReporter(), token());
        await settle();
        const clean = engine.clean();
        await settled();
        assert.deepStrictEqual(world.commandsMatching(/^ceedling clean/), [], 'no clean while the shared build root builds');
        build.release();
        await Promise.all([run, clean]);
        assert.strictEqual(world.commandsMatching(/^ceedling clean/).length, 2);
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
        const discovery = makeEngine(world).discover();
        // The gate holds only source reads. Reading the configuration comes before dumpconfig.
        // eslint-disable-next-line no-await-in-loop -- polls until discovery reaches dumpconfig
        while (!world.commandsMatching(/dumpconfig/).length) await settle();
        world.readGate = new Promise((resolve) => { open = resolve; });
        // eslint-disable-next-line no-await-in-loop -- polls until discovery reaches listing
        while (!world.commandsMatching(/files:test/).length) await settle();
        await settle();
        assert.deepStrictEqual(world.reads.filter((r) => r.includes('/test/')), [`${WS}/test/test_calc.c`, `${WS}/test/test_more.c`]);
        open();
        const [project] = await discovery;
        assert.deepStrictEqual(project.files.map((f) => f.id), ['test/test_calc.c', 'test/test_more.c']);
    });
});

// A resolved configuration enabling the gcov plugin, with its defaults as Ceedling merges them.
function gcovConfig(options: { utilities?: string[], reports?: string[], reportTask?: boolean, testPaths?: string[] } = {}): string {
    const list = (items: string[]) => items.length === 0 ? ' []\n' : `\n${items.map((item) => `    - ${item}\n`).join('')}`;
    return ':plugins:\n  :enabled:\n    - report_tests_log_factory\n    - gcov\n:unity:\n  :use_param_tests: true\n' +
        `:paths:\n  :test:${list((options.testPaths ?? ['+:test/**']).map((p) => `"${p}"`))}` +
        `:gcov:\n  :report_task: ${options.reportTask === true}\n  :utilities:${list(options.utilities ?? ['gcovr'])}  :reports:${list(options.reports ?? ['Cobertura'])}`;
}

// A Cobertura report covering `files`, each line as [number, hits].
function cobertura(sources: string[], files: Array<{ filename: string, lines: Array<[number, number]> }>): string {
    const classes = files.map((f) => `<class filename="${f.filename}"><methods/><lines>${f.lines.map(([n, h]) => `<line number="${n}" hits="${h}" branch="false"/>`).join('')}</lines></class>`).join('');
    return `<?xml version="1.0"?><coverage><sources>${sources.map((source) => `<source>${source}</source>`).join('')}</sources>` +
        `<packages><package><classes>${classes}</classes></package></packages></coverage>`;
}

const GCOVR_REPORT = `${WS}/build/artifacts/gcov/gcovr/GcovCoverageCobertura.xml`;
const CALC_COVERAGE = cobertura(['.'], [{ filename: 'src/calc.c', lines: [[1, 2], [2, 0]] }]);

// A project with the gcov plugin, whose coverage tasks pass and write `writes` besides their CppUnit report.
function coverageWorld(writes: Record<string, string> = { [GCOVR_REPORT]: CALC_COVERAGE }, config = gcovConfig()): FakeCeedling {
    const world = new FakeCeedling();
    world.resolvedConfig = config;
    world.write(`${WS}/src/calc.c`, 'int add(int a, int b) { return a + b; }\n');
    world.handlers.push((command) => /^ceedling gcov:/.test(command)
        ? { writes: { ...world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add'] }), 'build', 'gcov'), ...writes } }
        : undefined);
    return world;
}

const coverageCalls = (reporter: ReturnType<typeof recordingReporter>) => reporter.of('coverage').map((c) => c[1]);

suite('CeedlingEngine coverage', () => {
    test('coverage is available only while some project enables the gcov plugin', async () => {
        assert.strictEqual((await discovered(new FakeCeedling())).engine.coverageEnabled(), false);
        assert.strictEqual((await discovered(coverageWorld())).engine.coverageEnabled(), true);
    });

    // Before 1.2.1, Ceedling's gcov: task prefixes the test file prefix to a name lacking it, so
    // `test/test_calc.c` becomes `test_test/test_calc.c` and matches nothing.
    test('a file runs through gcov: with the bare file name, results from the gcov artifacts, and its coverage', async () => {
        const world = coverageWorld();
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/), [`ceedling gcov:test_calc.c --force-test-rerun ${PROJECT_ARGS}`]);
        assert.deepStrictEqual(reporter.of('passed').map((c) => c[1]), ['test/test_calc.c::test_add']);
        assert.deepStrictEqual(coverageCalls(reporter), [{
            kind: 'report', path: GCOVR_REPORT,
            files: [{ path: `${WS}/src/calc.c`, lines: [{ line: 1, hits: 2, branches: [] }, { line: 2, hits: 0, branches: [] }], functions: [] }],
        }]);
    });

    // Ceedling 1.2.1's gcov: tasks take the same project-relative path as its test: tasks.
    test('from Ceedling 1.2.1, a coverage run names its file by path, and same-named files need no warning', async () => {
        const world = coverageWorld();
        world.version = '1.2.1';
        world.testFiles = ['test/a/test_calc.c', 'test/b/test_calc.c'];
        for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
        const logs: LogCall[] = [];
        const { engine, file } = await discovered(world, { logs });
        await engine.runFile('default', file, recordingReporter(), token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/), [`ceedling gcov:test/a/test_calc.c --force-test-rerun ${PROJECT_ARGS}`]);
        assert.ok(!logs.some((l) => l.level === 'warn' && /test\/b\/test_calc\.c/.test(l.message)));
    });

    test('a function narrows its coverage run with --test-case', async () => {
        const world = coverageWorld();
        const { engine, file } = await discovered(world);
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/), [`ceedling gcov:test_calc.c --test-case=test_add --force-test-rerun ${PROJECT_ARGS}`]);
    });

    test('a project runs gcov:all', async () => {
        const world = coverageWorld();
        const { engine, projects } = await discovered(world);
        await engine.runProjectAll('default', projects[0].files, recordingReporter(), token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/), [`ceedling gcov:all --force-test-rerun ${PROJECT_ARGS}`]);
    });

    test('the configured coverage arguments replace the default task', async () => {
        const world = coverageWorld();
        const { engine, file } = await discovered(world, { settings: { coverageCommandArgs: ['gcov:${TEST_ID}', '--verbosity=obnoxious'] } });
        await engine.runFile('default', file, recordingReporter(), token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/), [`ceedling gcov:test_calc.c --verbosity=obnoxious --force-test-rerun ${PROJECT_ARGS}`]);
    });

    test('reports deferred to the report:gcov task are generated in the same run, once', async () => {
        const world = coverageWorld(undefined, gcovConfig({ reportTask: true }));
        const { engine, file } = await discovered(world);
        await engine.runFile('default', file, recordingReporter(), token(), coverageMode());
        const { engine: own } = await discovered(world, { settings: { coverageCommandArgs: ['gcov:${TEST_ID}', 'report:gcov'] } });
        await own.runFile('default', file, recordingReporter(), token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/), [
            `ceedling gcov:test_calc.c report:gcov --force-test-rerun ${PROJECT_ARGS}`,
            `ceedling gcov:test_calc.c report:gcov --force-test-rerun ${PROJECT_ARGS}`,
        ]);
    });

    test("counters from earlier runs are cleared once per run, before its first build", async () => {
        const world = coverageWorld();
        const { engine, file } = await discovered(world);
        const counters = [`${WS}/build/gcov/out/test_calc/calc.gcda`, `${WS}/build/gcov/out/test_calc/calc.c##1.gcov`];
        const kept = [`${WS}/build/gcov/out/test_calc/calc.gcno`, `${WS}/build/gcov/out/test_calc/calc.o`];
        for (const f of [...counters, ...kept]) world.write(f, '');
        const mode = coverageMode();
        await engine.runFile('default', file, recordingReporter(), token(), mode);
        assert.deepStrictEqual(counters.filter((f) => world.files.has(f)), []);
        assert.deepStrictEqual(kept.filter((f) => world.files.has(f)), kept);
        world.write(counters[0], '');
        await engine.runFile('default', file, recordingReporter(), token(), mode);
        assert.ok(world.files.has(counters[0]), 'a later build in the same run keeps the counters this run produced');
        await engine.runFile('default', file, recordingReporter(), token(), coverageMode());
        assert.ok(!world.files.has(counters[0]), 'a new run clears them again');
    });

    // Otherwise the fallback would count the first attempt's tests twice.
    test("a function run's whole-file fallback clears its first attempt's counters, and no other test's", async () => {
        const world = coverageWorld();
        const counter = `${WS}/build/gcov/out/test_calc/calc.gcda`;
        const otherTest = `${WS}/build/gcov/out/test_other/other.gcda`;
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: { ...world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_add_more'] }), 'build', 'gcov'), [counter]: '' } }
            : undefined);
        const { engine, file } = await discovered(world);
        const mode = coverageMode();
        await engine.runFile('default', file, recordingReporter(), token(), mode);
        world.write(otherTest, '');
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token(), mode);
        assert.deepStrictEqual(world.commandsMatching(/^ceedling gcov:/).slice(1), [
            `ceedling gcov:test_calc.c --test-case=test_add --force-test-rerun ${PROJECT_ARGS}`,
            `ceedling gcov:test_calc.c --force-test-rerun ${PROJECT_ARGS}`,
        ]);
        assert.ok(!world.files.has(counter));
        assert.ok(world.files.has(otherTest));
    });

    // From Ceedling 1.2.0, gcov/out nests each test's counters under the test file's directory
    // within its test path, e.g. gcov/out/unit/test_calc/ for test/unit/test_calc.c.
    test("a function run's whole-file fallback keeps the counters of same-named test files elsewhere", async () => {
        const world = coverageWorld();
        world.version = '1.2.1';
        world.testFiles = ['test/test_calc.c', 'test/unit/test_calc.c', 'test/integration/test_calc.c'];
        for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
        const counters = {
            root: `${WS}/build/gcov/out/test_calc/calc.gcda`,
            unit: `${WS}/build/gcov/out/unit/test_calc/calc.gcda`,
            integration: `${WS}/build/gcov/out/integration/test_calc/calc.gcda`,
            integrationNested: `${WS}/build/gcov/out/integration/test_calc/sub/a/util.gcda`,
            unitNested: `${WS}/build/gcov/out/unit/test_calc/sub/a/util.gcda`,
        };
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/integration/test_calc.c::test_add', 'test/integration/test_calc.c::test_add_more'] }), 'build', 'gcov') }
            : undefined);
        const { engine, projects } = await discovered(world);
        const file = (id: string) => projects[0].files.find((f) => f.id === id)!;
        const mode = coverageMode();
        // A first build spends the request's one counter reset, which would clear the counters below.
        await engine.runFile('default', file('test/test_calc.c'), recordingReporter(), token(), mode);
        for (const counter of Object.values(counters)) world.write(counter, '');
        const integration = file('test/integration/test_calc.c');
        await engine.runFunction('default', integration, integration.functions[0], recordingReporter(), token(), mode);
        assert.strictEqual(world.commandsMatching(/^ceedling gcov:test\/integration\/test_calc\.c --force/).length, 1, 'the fallback ran');
        assert.deepStrictEqual(Object.entries(counters).filter(([, f]) => world.files.has(f)).map(([k]) => k), ['root', 'unit', 'unitNested']);
    });

    // From 1.2.2 a test's counters sit under its path from the project root, test root included.
    test("from Ceedling 1.2.2, a function run's whole-file fallback clears the counters under the test's own path", async () => {
        const world = coverageWorld();
        world.version = '1.2.2';
        world.testFiles = ['test/test_calc.c', 'test/unit/test_calc.c'];
        for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
        const own = `${WS}/build/gcov/out/test/unit/test_calc/src/calc.gcda`;
        const namesake = `${WS}/build/gcov/out/test/test_calc/src/calc.gcda`;
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add', 'test/unit/test_calc.c::test_add_more'] }), 'build', 'gcov') }
            : undefined);
        const { engine, projects } = await discovered(world);
        const file = (id: string) => projects[0].files.find((f) => f.id === id)!;
        const mode = coverageMode();
        // A first build spends the request's one counter reset, which would clear the counters below.
        await engine.runFile('default', file('test/test_calc.c'), recordingReporter(), token(), mode);
        world.write(own, '');
        world.write(namesake, '');
        const unit = file('test/unit/test_calc.c');
        await engine.runFunction('default', unit, unit.functions[0], recordingReporter(), token(), mode);
        assert.deepStrictEqual([own, namesake].map((f) => world.files.has(f)), [false, true]);
    });

    // A misreported release may lay its counters out as another release does, so each layout's
    // place for them clears, except one that is another test's own.
    test("with a misreported release, a function run's whole-file fallback clears the counters each layout places, not a namesake's", async () => {
        const world = coverageWorld();
        runsAnotherCeedling(world, launching('1.2.1-47d2c5e', '1.2.1-13a540f'));
        world.testFiles = ['test/test_calc.c', 'test/unit/test_calc.c'];
        for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
        const counters = {
            projectPath: `${WS}/build/gcov/out/test/unit/test_calc/src/calc.gcda`,
            testRoot: `${WS}/build/gcov/out/unit/test_calc/calc.gcda`,
            namesake: `${WS}/build/gcov/out/test_calc/calc.gcda`,
        };
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add', 'test/unit/test_calc.c::test_add_more'] }), 'build', 'gcov') }
            : undefined);
        const { engine, projects } = await discovered(world);
        const file = (id: string) => projects[0].files.find((f) => f.id === id)!;
        const mode = coverageMode();
        // A first build spends the request's one counter reset, which would clear the counters below.
        await engine.runFile('default', file('test/test_calc.c'), recordingReporter(), token(), mode);
        for (const counter of Object.values(counters)) world.write(counter, '');
        const unit = file('test/unit/test_calc.c');
        await engine.runFunction('default', unit, unit.functions[0], recordingReporter(), token(), mode);
        assert.deepStrictEqual(Object.entries(counters).filter(([, f]) => world.files.has(f)).map(([k]) => k), ['namesake']);
    });

    test("a function run's whole-file fallback clears the counters its own test path places, not a namesake's", async () => {
        const world = coverageWorld(undefined, gcovConfig({ testPaths: ['+:test/unit/**', '+:extra/**'] }));
        world.version = '1.2.1';
        world.testFiles = ['test/unit/test_calc.c', 'extra/unit/test_calc.c'];
        for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
        const own = `${WS}/build/gcov/out/test_calc/calc.gcda`;
        const namesake = `${WS}/build/gcov/out/unit/test_calc/calc.gcda`;
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add', 'test/unit/test_calc.c::test_add_more'] }), 'build', 'gcov') }
            : undefined);
        const { engine, projects } = await discovered(world);
        const file = projects[0].files.find((f) => f.id === 'test/unit/test_calc.c')!;
        const mode = coverageMode();
        // A first build spends the request's one counter reset, which would clear the counters below.
        await engine.runFile('default', file, recordingReporter(), token(), mode);
        world.write(own, '');
        world.write(namesake, '');
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token(), mode);
        assert.deepStrictEqual([own, namesake].map((f) => world.files.has(f)), [false, true]);
    });

    test("before Ceedling 1.2.0, a function run's whole-file fallback clears the counters under the test's bare name", async () => {
        const world = coverageWorld();
        world.version = '1.1.10';
        world.testFiles = ['test/unit/test_calc.c'];
        world.write(`${WS}/test/unit/test_calc.c`, 'void test_add(void) {}\n');
        const counter = `${WS}/build/gcov/out/test_calc/calc.gcda`;
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: world.reportWrite(cppunit({ passed: ['test/unit/test_calc.c::test_add', 'test/unit/test_calc.c::test_add_more'] }), 'build', 'gcov') }
            : undefined);
        const { engine, file } = await discovered(world);
        const mode = coverageMode();
        await engine.runFile('default', file, recordingReporter(), token(), mode);
        world.write(counter, '');
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token(), mode);
        assert.ok(!world.files.has(counter));
    });

    // Windows keeps the case a directory was created with, which may differ from the file's path.
    test("on Windows, a function run's whole-file fallback finds its counters whatever their directories' case", async () => {
        const world = new FakeCeedling();
        world.version = '1.2.1';
        world.resolvedConfig = gcovConfig();
        world.testFiles = ['test/unit/test_calc.c', 'test/integration/test_calc.c'];
        world.write('C:\\ws\\project.yml', ':project: {}\n');
        for (const f of world.testFiles) world.write(`C:\\ws\\${f.replace(/\//g, '\\')}`, 'void test_add(void) {}\n');
        const own = 'C:\\ws\\build\\gcov\\out\\Unit\\Test_Calc\\calc.gcda';
        const namesake = 'C:\\ws\\build\\gcov\\out\\integration\\test_calc\\calc.gcda';
        world.handlers.push((command) => /^ceedling gcov:/.test(command) ? { writes: {
            'C:\\ws\\build\\artifacts\\gcov\\cppunit_tests_report.xml': cppunit({ passed: ['test/unit/test_calc.c::test_add', 'test/unit/test_calc.c::test_add_more'] }),
        } } : undefined);
        const engine = makeEngine(world, { folder: 'C:\\ws', platform: 'win32' });
        const [project] = await engine.discover();
        const unit = project.files.find((f) => f.id === 'test/unit/test_calc.c')!;
        const mode = coverageMode();
        await engine.runFile('default', unit, recordingReporter(), token(), mode);
        world.write(own, '');
        world.write(namesake, '');
        await engine.runFunction('default', unit, unit.functions[0], recordingReporter(), token(), mode);
        assert.deepStrictEqual([own, namesake].map((f) => world.files.has(f)), [false, true]);
    });

    test("a function run's whole-file fallback keeps every counter when counters accumulate", async () => {
        const world = coverageWorld();
        const counter = `${WS}/build/gcov/out/test_calc/calc.gcda`;
        world.handlers.unshift((command) => /--test-case/.test(command)
            ? { writes: { ...world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add', 'test/test_calc.c::test_add_more'] }), 'build', 'gcov'), [counter]: '' } }
            : undefined);
        const { engine, file } = await discovered(world, { settings: { coverageResetsCounters: false } });
        await engine.runFunction('default', file, file.functions[0], recordingReporter(), token(), coverageMode());
        assert.strictEqual(world.commandsMatching(/^ceedling gcov:/).length, 2, 'the fallback ran');
        assert.ok(world.files.has(counter));
    });

    test('each build directory has its counters cleared once per run', async () => {
        const world = coverageWorld();
        for (const dir of ['a', 'b']) {
            world.directories.add(`${WS}/${dir}`);
            world.write(`${WS}/${dir}/project.yml`, ':project: {}\n');
            world.write(`${WS}/${dir}/build/gcov/out/test_calc/calc.gcda`, '');
        }
        const { engine, projects } = await discovered(world, { settings: { projects: ['a', 'b'].map((dir) => ({ path: dir, debugLaunchConfig: 'dbg' })) } });
        const mode = coverageMode();
        for (const project of projects) {
            // eslint-disable-next-line no-await-in-loop -- one project after the other, as a run plan does
            await engine.runProjectAll(project.projectKey, project.files, recordingReporter(), token(), mode);
        }
        assert.deepStrictEqual(['a', 'b'].filter((dir) => world.files.has(`${WS}/${dir}/build/gcov/out/test_calc/calc.gcda`)), []);
    });

    test('counters accumulate across runs when the setting says so', async () => {
        const world = coverageWorld();
        const { engine, file } = await discovered(world, { settings: { coverageResetsCounters: false } });
        world.write(`${WS}/build/gcov/out/test_calc/calc.gcda`, '');
        await engine.runFile('default', file, recordingReporter(), token(), coverageMode());
        assert.ok(world.files.has(`${WS}/build/gcov/out/test_calc/calc.gcda`));
    });

    test("a build that writes no coverage report shows none, not the last run's", async () => {
        const world = coverageWorld({});
        world.write(GCOVR_REPORT, CALC_COVERAGE);
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        const [outcome] = coverageCalls(reporter) as Array<{ kind: string, message: string }>;
        assert.strictEqual(outcome.kind, 'missing');
        assert.match(outcome.message, /GcovCoverageCobertura\.xml/);
    });

    test("gcovr's report is read when both utilities write one", async () => {
        const reportGenerator = `${WS}/build/artifacts/gcov/ReportGenerator/Cobertura.xml`;
        const world = coverageWorld({ [GCOVR_REPORT]: CALC_COVERAGE, [reportGenerator]: cobertura(['.'], [{ filename: 'src/calc.c', lines: [[1, 9]] }]) },
            gcovConfig({ utilities: ['gcovr', 'ReportGenerator'] }));
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.strictEqual((coverageCalls(reporter)[0] as { path: string }).path, GCOVR_REPORT);
    });

    // ReportGenerator lists each source directory it was given, and names files relative to the
    // one it ran in, so only one source yields a real file.
    test("ReportGenerator's nested report is read, each file at the candidate path that exists", async () => {
        const nested = `${WS}/build/artifacts/gcov/ReportGenerator/Cobertura/Cobertura.xml`;
        const world = coverageWorld({ [nested]: cobertura(['src', '.'], [{ filename: './src/calc.c', lines: [[1, 1]] }]) },
            gcovConfig({ utilities: ['ReportGenerator'] }));
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.deepStrictEqual(coverageCalls(reporter).map((o) => (o as { path: string, files: Array<{ path: string }> }))
            .map((o) => [o.path, o.files.map((f) => f.path)]), [[nested, [`${WS}/src/calc.c`]]]);
    });

    test("ReportGenerator's real report resolves every file, inside the project and above it", async () => {
        const report = `${WS}/build/artifacts/gcov/ReportGenerator/Cobertura.xml`;
        const world = coverageWorld({ [report]: fs.readFileSync(path.resolve(fixturesRoot, 'reportgenerator-5.5.11', 'cobertura-probe.xml'), 'utf8') },
            gcovConfig({ utilities: ['ReportGenerator'] }));
        world.write(`${WS}/src/Calculator.c`, '');
        world.write('/lib/Clamp.c', '');
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.deepStrictEqual((coverageCalls(reporter)[0] as { files: Array<{ path: string }> }).files.map((f) => f.path), ['/lib/Clamp.c', `${WS}/src/Calculator.c`]);
    });

    test('a project writing no Cobertura report runs with coverage and says what to configure', async () => {
        const world = coverageWorld({}, gcovConfig({ reports: [] }));
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.strictEqual(world.commandsMatching(/^ceedling gcov:/).length, 1);
        assert.match((coverageCalls(reporter)[0] as { message: string }).message, /:reports:/);
    });

    test('a project without the gcov plugin runs its tests as usual and says why there is no coverage', async () => {
        const world = new FakeCeedling();
        world.handlers.push((command) => /^ceedling test:/.test(command) ? { writes: world.reportWrite(cppunit({ passed: ['test/test_calc.c::test_add'] })) } : undefined);
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.deepStrictEqual(world.commandsMatching(/^ceedling (test|gcov):/), [`ceedling test:test/test_calc.c --force-test-rerun ${PROJECT_ARGS}`]);
        assert.match((coverageCalls(reporter)[0] as { message: string }).message, /gcov plugin/);
    });

    test("a build that fails explains a project's missing coverage configuration all the same", async () => {
        const world = coverageWorld({}, gcovConfig({ reports: [] }));
        world.handlers.unshift((command) => /^ceedling gcov:/.test(command) ? { error: true } : undefined);
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.match((coverageCalls(reporter)[0] as { message: string }).message, /:reports:/);
    });

    // Its test errors already explain a failed build.
    test('a failed build in a project configured for coverage reports no coverage outcome', async () => {
        const world = coverageWorld();
        world.handlers.unshift((command) => /^ceedling gcov:/.test(command) ? { error: true } : undefined);
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.deepStrictEqual(coverageCalls(reporter), []);
        assert.ok(reporter.of('errored').length > 0);
    });

    test('a report covering no source files says where gcovr looks', async () => {
        const world = coverageWorld({ [GCOVR_REPORT]: cobertura(['.'], []) });
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.match((coverageCalls(reporter)[0] as { message: string }).message, /:report_root:/);
    });

    test('a file whose candidates all fail to exist keeps its first', async () => {
        const world = coverageWorld({ [GCOVR_REPORT]: cobertura(['src', 'lib'], [{ filename: 'gone.c', lines: [[1, 1]] }]) });
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.deepStrictEqual((coverageCalls(reporter)[0] as { files: Array<{ path: string }> }).files.map((f) => f.path), [`${WS}/src/gone.c`]);
    });

    // Before 1.2.1, Ceedling's gcov: tasks take a bare name, so they can't tell the two files apart.
    // Ceedling 1.2.0 then refuses the name as ambiguous, and earlier versions take the first match.
    for (const [version, outcome] of [['1.2.0', /Ceedling 1\.2\.0 can't tell .* It stops with an ambiguous file reference error\. Ceedling 1\.2\.1 and later take its path\./], ['1.1.10-85ec551', /Ceedling 1\.1\.10 can't tell .* It may run the other file\. Ceedling 1\.2\.1 and later take its path\./]] as const) {
        test(`with Ceedling ${version}, a coverage run of one of two same-named test files warns what Ceedling does with its name`, async () => {
            const world = coverageWorld();
            world.version = version;
            world.testFiles = ['test/a/test_calc.c', 'test/b/test_calc.c'];
            for (const f of world.testFiles) world.write(`${WS}/${f}`, 'void test_add(void) {}\n');
            const logs: LogCall[] = [];
            const { engine, file } = await discovered(world, { logs });
            await engine.runFile('default', file, recordingReporter(), token(), coverageMode());
            const warnings = logs.filter((l) => l.level === 'warn' && /test\/a\/test_calc\.c/.test(l.message) && /test\/b\/test_calc\.c/.test(l.message));
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0].message, outcome);
        });
    }

    test('on Windows, counters and reports are found under the project, whatever the case of its path', async () => {
        const world = new FakeCeedling();
        world.resolvedConfig = gcovConfig();
        world.write('C:\\ws\\project.yml', ':project: {}\n');
        world.write('C:\\ws\\test\\test_calc.c', 'void test_add(void) {}\n');
        world.write('C:\\ws\\build\\gcov\\out\\test_calc\\calc.gcda', '');
        world.handlers.push((command) => /^ceedling gcov:/.test(command) ? { writes: {
            'C:\\ws\\build\\artifacts\\gcov\\cppunit_tests_report.xml': cppunit({ passed: ['test/test_calc.c::test_add'] }),
            'C:\\ws\\build\\artifacts\\gcov\\gcovr\\GcovCoverageCobertura.xml': cobertura(['.'], [{ filename: 'src\\calc.c', lines: [[1, 1]] }]),
        } } : undefined);
        const engine = makeEngine(world, { folder: 'c:\\ws', platform: 'win32' });
        const [project] = await engine.discover();
        const reporter = recordingReporter();
        await engine.runFile('default', project.files[0], reporter, token(), coverageMode());
        assert.ok(!world.files.has('C:\\ws\\build\\gcov\\out\\test_calc\\calc.gcda'));
        assert.deepStrictEqual((coverageCalls(reporter)[0] as { files: Array<{ path: string }> }).files.map((f) => f.path), ['C:\\ws\\src\\calc.c']);
        assert.strictEqual(engine.keyOfPath('c:\\WS\\Src\\Calc.c'), engine.keyOfPath('C:\\ws\\src\\calc.c'));
    });

    test('an unreadable coverage report is reported as missing, naming it', async () => {
        const world = coverageWorld({ [GCOVR_REPORT]: '<coverage><packages>' });
        const { engine, file } = await discovered(world);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, token(), coverageMode());
        assert.match((coverageCalls(reporter)[0] as { message: string }).message, /GcovCoverageCobertura\.xml/);
    });

    test('a cancelled coverage run reports no coverage', async () => {
        const world = coverageWorld();
        const { engine, file } = await discovered(world);
        const cancel = token();
        world.handlers.unshift((command) => /^ceedling gcov:/.test(command)
            ? new Promise<Reply>((resolve) => setImmediate(() => { cancel.fire(); resolve({ error: true }); }))
            : undefined);
        const reporter = recordingReporter();
        await engine.runFile('default', file, reporter, cancel, coverageMode());
        assert.deepStrictEqual(coverageCalls(reporter), []);
        assert.deepStrictEqual(reporter.of('skipped').length, leafIds(file.functions).length);
    });
});
