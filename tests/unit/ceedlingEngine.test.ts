import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import yaml from 'js-yaml';
import * as path from 'path';
import type vscode from 'vscode';
import * as xml2js from 'xml2js';
import { CeedlingEngine, CeedlingFileNode } from '../../src/ceedlingEngine';
import { getTestListFromXmlReport } from '../../src/ceedlingXmlReport';
import type { Logger } from '../../src/logger';
import type { ProblemMatcher } from '../../src/problemMatcher';

// Exercises CeedlingEngine's `ceedling dumpconfig`-backed config resolution and its
// --project/--mixin command construction, with child_process/fs/vscode all faked - see
// makeEngine()/withProject() below. A few tests instead replay real `ceedling dumpconfig` output
// captured against tests/manual (see tests/fixtures/dumpconfig/), to ground the faked-YAML tests
// against what Ceedling itself actually produces.

function fakeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return {
        uri: { fsPath, toString: () => `file://${fsPath}` },
        name: 'fake',
        index: 0,
    } as unknown as vscode.WorkspaceFolder;
}

type RecordedCall = { level: string, message: string };
type FakeLogger = Logger & { calls: RecordedCall[] };

// A no-op Logger by default; every call is also recorded in `.calls` for tests that need to
// assert on what was logged (the warning/debug-enrichment tests below).
function fakeLogger(): FakeLogger {
    const calls: RecordedCall[] = [];
    const record = (level: string) => (...args: unknown[]) => { calls.push({ level, message: String(args[0]) }); };
    return {
        trace: record('trace'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error'),
        showInfo: record('showInfo'), showError: record('showError'), showWarning: record('showWarning'),
        dispose() { },
        calls,
    } as unknown as FakeLogger;
}

function fakeConfig(settings: Record<string, any>): vscode.WorkspaceConfiguration {
    return {
        get: (key: string, def?: any) => (key in settings ? settings[key] : def),
    } as unknown as vscode.WorkspaceConfiguration;
}

function fakeProblemMatcher(): ProblemMatcher {
    return {
        scan: () => [],
        dispose() { },
        clear() { },
        setActualIds() { },
    } as unknown as ProblemMatcher;
}

// Records every invocation instead of actually spawning anything; resolves each call
// with an empty successful result unless a call-specific result is queued.
function fakeExec(calls: { command: string, options: any }[]): typeof child_process.exec {
    return ((command: string, options: any, callback: any) => {
        calls.push({ command, options });
        callback(null, '', '');
        return {} as child_process.ChildProcess;
    }) as unknown as typeof child_process.exec;
}

const FAKE_BUNDLED_MIXIN_PATH = '/ext/assets/mixins/report-tests-log-factory.yml';

function makeEngine(opts: {
    exec?: typeof child_process.exec,
    readFile?: typeof fs.readFile,
    settings?: Record<string, any>,
    isDevelopmentMode?: boolean,
    bundledMixinPath?: string,
    logger?: FakeLogger,
    workspacePath?: string,
} = {}): CeedlingEngine {
    return new CeedlingEngine(
        fakeWorkspaceFolder(opts.workspacePath ?? '/ws'),
        opts.logger ?? fakeLogger(),
        opts.isDevelopmentMode ?? false,
        {
            configProvider: () => fakeConfig(opts.settings ?? {}),
            problemMatcher: fakeProblemMatcher(),
            bundledMixinPath: opts.bundledMixinPath ?? FAKE_BUNDLED_MIXIN_PATH,
            exec: opts.exec,
            readFile: opts.readFile,
        },
    );
}

// Installs one project directly on the engine's private project map, bypassing
// loadProjectPaths() (which needs real fs.existsSync/lstatSync this seam doesn't cover).
function withProject(engine: CeedlingEngine, key: string, data: { absPath: string, ymlFileName: string, mixins?: string[] }) {
    (engine as any).projectData = {
        [key]: { debugLaunchConfig: 'ceedling', projectPath: '.', files: {}, mixins: [], ...data },
    };
}

// Matches readFile calls by pattern rather than exact path: loadResolvedConfig's dumpconfig
// output path is generated fresh (pid/timestamp/random) on every call, not a fixed name.
function fakeReadFileMatching(pattern: RegExp, content: string | undefined): typeof fs.readFile {
    return ((filePath: string, _encoding: any, callback: any) => {
        if (content !== undefined && pattern.test(filePath)) {
            callback(null, content);
        } else {
            callback(Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' }), undefined);
        }
    }) as unknown as typeof fs.readFile;
}

const DUMPCONFIG_OUTPUT_PATTERN = /ceedling-dumpconfig-.*\.yml$/;

suite('loadResolvedConfig (backed by `ceedling dumpconfig`)', () => {
    test('runs dumpconfig with a .yml output path and parses what it wrote', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({
            exec: fakeExec(calls),
            readFile: fakeReadFileMatching(DUMPCONFIG_OUTPUT_PATTERN, ':project:\n  :build_root: from_dumpconfig\n'),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        const result = await (engine as any).loadResolvedConfig('proj');
        assert.match(calls[0].command, /^ceedling dumpconfig \S*\.yml /);
        assert.deepStrictEqual(result, { ':project': { ':build_root': 'from_dumpconfig' } });
    });

    test('resolves undefined when dumpconfig itself reports an error', async () => {
        const engine = makeEngine({
            exec: ((command: string, options: any, callback: any) => {
                callback(new Error('ceedling: command not found'), '', 'ceedling: command not found');
                return {} as child_process.ChildProcess;
            }) as unknown as typeof child_process.exec,
            readFile: fakeReadFileMatching(DUMPCONFIG_OUTPUT_PATTERN, ':project: {}\n'),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        const result = await (engine as any).loadResolvedConfig('proj');
        assert.strictEqual(result, undefined);
    });

    test('resolves undefined when the dumpconfig output file cannot be read', async () => {
        const engine = makeEngine({
            exec: fakeExec([]),
            readFile: fakeReadFileMatching(DUMPCONFIG_OUTPUT_PATTERN, undefined),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        const result = await (engine as any).loadResolvedConfig('proj');
        assert.strictEqual(result, undefined);
    });

    test('resolves undefined when the dumpconfig output fails to parse', async () => {
        const engine = makeEngine({
            exec: fakeExec([]),
            readFile: fakeReadFileMatching(DUMPCONFIG_OUTPUT_PATTERN, ':project: [\n  broken'),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        const result = await (engine as any).loadResolvedConfig('proj');
        assert.strictEqual(result, undefined);
    });
});

suite('checkYmlProjectData (reads the resolvedConfig cache populated during discover())', () => {
    test('reports a load failure, naming the real ceedlingExplorer.projects setting', async () => {
        const engine = makeEngine();
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).resolvedConfig = { proj: undefined };
        const error = await (engine as any).checkYmlProjectData('proj');
        assert.match(error, /ceedlingExplorer\.projects/);
    });

    test('reports the plugin-not-enabled error when report_tests_log_factory is missing from the resolved config', async () => {
        const engine = makeEngine();
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).resolvedConfig = { proj: { ':plugins': { ':enabled': ['other_plugin'] } } };
        const error = await (engine as any).checkYmlProjectData('proj');
        assert.match(error, /report_tests_log_factory.*did not take effect/);
    });

    test('reports nothing when report_tests_log_factory is enabled in the resolved config', async () => {
        const engine = makeEngine();
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).resolvedConfig = { proj: { ':plugins': { ':enabled': ['report_tests_log_factory'] } } };
        const error = await (engine as any).checkYmlProjectData('proj');
        assert.strictEqual(error, undefined);
    });
});

suite('execCeedling: --project/--mixin flag construction', () => {
    test('before the version check completes, no --project/--mixin flags are added and cwd is "."', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        await (engine as any).execCeedling(['version']);
        assert.strictEqual(calls[0].command, 'ceedling version');
        assert.strictEqual(calls[0].options.cwd, '.');
    });

    test('once version-checked, a default project.yml gets --project and the bundled report-plugin mixin, cwd set to the project', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        await (engine as any).execCeedling(['test:all'], 'proj');
        assert.strictEqual(calls[0].command, `ceedling test:all --project project.yml --mixin ${FAKE_BUNDLED_MIXIN_PATH}`);
        assert.strictEqual(calls[0].options.cwd, '/ws/proj');
    });

    test('an alternate/mixin yml file name adds its own --mixin flag, lowest priority (right after --project)', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'ci.yml' });
        (engine as any).ceedlingVersionChecked = true;
        await (engine as any).execCeedling(['test:all'], 'proj');
        assert.strictEqual(
            calls[0].command,
            `ceedling test:all --project project.yml --mixin ci.yml --mixin ${FAKE_BUNDLED_MIXIN_PATH}`,
        );
    });

    test("the project's configured mixins land between the alternate yml and the bundled mixin, in order", async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml', mixins: ['gcc', 'proj/mixins/coverage.yml'] });
        (engine as any).ceedlingVersionChecked = true;
        await (engine as any).execCeedling(['test:all'], 'proj');
        assert.strictEqual(
            calls[0].command,
            `ceedling test:all --project project.yml --mixin gcc --mixin proj/mixins/coverage.yml --mixin ${FAKE_BUNDLED_MIXIN_PATH}`,
        );
    });

    test('the verbosity flag is only spliced on in development mode', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls), isDevelopmentMode: false });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        await (engine as any).execCeedling(['test:all'], 'proj', '--verbosity debug');
        assert.doesNotMatch(calls[0].command, /--verbosity/);

        const devCalls: { command: string, options: any }[] = [];
        const devEngine = makeEngine({ exec: fakeExec(devCalls), isDevelopmentMode: true });
        withProject(devEngine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (devEngine as any).ceedlingVersionChecked = true;
        await (devEngine as any).execCeedling(['test:all'], 'proj', '--verbosity debug');
        assert.match(devCalls[0].command, /--verbosity debug$/);
    });
});

const dumpconfigFixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'dumpconfig');

function loadDumpconfigFixture(name: string): any {
    return yaml.safeLoad(fs.readFileSync(path.resolve(dumpconfigFixturesRoot, name), 'utf8'));
}

suite('real `ceedling dumpconfig` output (captured against tests/manual, see tests/fixtures/dumpconfig/README.md)', () => {
    test('without the bundled mixin, report_tests_log_factory is genuinely absent - checkYmlProjectData catches it', async () => {
        const engine = makeEngine();
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).resolvedConfig = { proj: loadDumpconfigFixture('manual-project-no-report-plugin.yml') };
        const error = await (engine as any).checkYmlProjectData('proj');
        assert.match(error, /report_tests_log_factory.*did not take effect/);
    });

    test('with the bundled mixin applied, report_tests_log_factory and its cppunit report are present', async () => {
        const engine = makeEngine();
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const resolvedConfig = loadDumpconfigFixture('manual-project-with-bundled-mixin.yml');
        (engine as any).resolvedConfig = { proj: resolvedConfig };
        const error = await (engine as any).checkYmlProjectData('proj');
        assert.strictEqual(error, undefined);
        assert.deepStrictEqual(resolvedConfig[':report_tests_log_factory'][':reports'], ['cppunit']);
    });

    test('setBuildDirectory/setXmlReportPath read real dumpconfig output correctly', () => {
        const engine = makeEngine();
        const resolvedConfig = loadDumpconfigFixture('manual-project-with-bundled-mixin.yml');
        (engine as any).setBuildDirectory('proj', resolvedConfig);
        (engine as any).setXmlReportPath('proj', resolvedConfig);
        assert.strictEqual((engine as any).buildDirectories['proj'], 'build');
        // No :cppunit: :filename: override in this real output - the plugin default applies.
        assert.strictEqual((engine as any).reportFilenames['proj'], 'cppunit_tests_report.xml');
    });
});

suite('getTestPrefix', () => {
    test('defaults to test|spec|should when no project data is given', () => {
        const engine = makeEngine({ logger: fakeLogger() });
        assert.strictEqual((engine as any).getTestPrefix(undefined), 'test|spec|should');
    });

    test('uses :test_runner: :test_prefix: when present', () => {
        const engine = makeEngine({ logger: fakeLogger() });
        const prefix = (engine as any).getTestPrefix({ ':test_runner': { ':test_prefix': 'my_test_prefix' } });
        assert.strictEqual(prefix, 'my_test_prefix');
    });

    test(':unity: :test_prefix: is no longer recognized and is ignored', () => {
        const engine = makeEngine({ logger: fakeLogger() });
        const prefix = (engine as any).getTestPrefix({ ':unity': { ':test_prefix': 'legacy_prefix' } });
        assert.strictEqual(prefix, 'test|spec|should');
    });

    test('missing :test_runner: data logs a debug message and falls back to the default', () => {
        const logger = fakeLogger();
        const engine = makeEngine({ logger });
        const prefix = (engine as any).getTestPrefix({});
        assert.strictEqual(prefix, 'test|spec|should');
        assert.ok(logger.calls.some((c) => c.level === 'debug' && /getTestPrefix/.test(c.message)));
    });
});

suite('setXmlReportPath: non-default report filename warning', () => {
    test('the default filename never warns', () => {
        const logger = fakeLogger();
        const engine = makeEngine({ logger });
        (engine as any).setXmlReportPath('proj', { ':report_tests_log_factory': { ':cppunit': { ':filename': 'cppunit_tests_report.xml' } } });
        assert.ok(!logger.calls.some((c) => c.level === 'showWarning'));
    });

    test('a non-default filename warns once, naming the project and the resolved filename', () => {
        const logger = fakeLogger();
        const engine = makeEngine({ logger });
        (engine as any).setXmlReportPath('proj', { ':report_tests_log_factory': { ':cppunit': { ':filename': 'custom_report.xml' } } });
        const warnings = logger.calls.filter((c) => c.level === 'showWarning');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0].message, /proj/);
        assert.match(warnings[0].message, /custom_report\.xml/);
    });

    test('the same non-default filename does not warn again on a later discover() cycle', () => {
        const logger = fakeLogger();
        const engine = makeEngine({ logger });
        const resolvedConfig = { ':report_tests_log_factory': { ':cppunit': { ':filename': 'custom_report.xml' } } };
        (engine as any).setXmlReportPath('proj', resolvedConfig);
        (engine as any).setXmlReportPath('proj', resolvedConfig);
        assert.strictEqual(logger.calls.filter((c) => c.level === 'showWarning').length, 1);
    });
});

suite('loadProjectPaths: mixins are logged for diagnosis', () => {
    test('the debug log naming a resolved project includes its resolved mixins', () => {
        const logger = fakeLogger();
        // loadProjectPaths() checks the workspace path against the real filesystem
        // (fs.existsSync/lstatSync, not part of the injected seam) - point it at this test
        // file's own real directory rather than the fake '/ws' the other tests use.
        const engine = makeEngine({
            logger,
            workspacePath: __dirname,
            settings: {
                projects: [{ path: '.', debugLaunchConfig: 'ceedling', mixins: ['gcc'] }],
            },
        });
        (engine as any).loadProjectPaths();
        const line = logger.calls.find((c) => c.level === 'debug' && c.message.includes('loadProjectPaths'));
        assert.ok(line, 'expected a loadProjectPaths debug log line');
        assert.match(line!.message, /mixins.*gcc/);
    });
});

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function parseXmlFixture(...segments: string[]): Promise<any> {
    const data = fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
    return new xml2js.Parser({ explicitArray: false }).parseStringPromise(data);
}

// The ids a run reports results against: a parametrized function's cases, or the function itself.
function leafIds(file: CeedlingFileNode): string[] {
    return file.functions.flatMap((fn) => fn.cases.length > 0 ? fn.cases.map((c) => c.id) : [fn.id]);
}

// Discovery must produce exactly the test names Ceedling reports, or a result has no item to land
// on and the item ends the run as skipped. Each report was captured by running
// tests/fixtures/source/test_whitespace.c through that Ceedling version, as test/test_whitespace.c.
suite('getTestFileNodes: discovered ids equal real Ceedling report names', () => {
    for (const version of ['ceedling-1.0.0', 'ceedling-1.1.10', 'ceedling-1.2.0']) {
        test(`${version}: test_whitespace.c`, async () => {
            const engine = makeEngine();
            withProject(engine, 'proj', { absPath: path.resolve(fixturesRoot, 'source'), ymlFileName: 'project.yml' });
            const [file] = Array.from((engine as any).getTestFileNodes('proj', ['test_whitespace.c']) as Iterable<CeedlingFileNode>);
            const report = await parseXmlFixture(version, 'cppunit-report-whitespace.xml');
            const reported = getTestListFromXmlReport(report, 'SuccessfulTests')
                .map((t: any) => (t['Name'] as string).replace(/^test\//, ''));
            assert.deepStrictEqual(leafIds(file), reported);
        });
    }
});
