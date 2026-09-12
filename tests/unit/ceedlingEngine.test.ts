import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import type vscode from 'vscode';
import { CeedlingEngine } from '../../src/ceedlingEngine';
import type { Logger } from '../../src/logger';
import type { ProblemMatcher } from '../../src/problemMatcher';

// Characterizes CeedlingEngine's current YAML-loading and command-construction behavior ahead of
// replacing it with `ceedling dumpconfig` (see the project plan). None of this is new behavior -
// every assertion here, including the ones that look like bugs, documents what the code already
// does, so the refactor has a baseline to diff against.

function fakeWorkspaceFolder(fsPath: string): vscode.WorkspaceFolder {
    return {
        uri: { fsPath, toString: () => `file://${fsPath}` },
        name: 'fake',
        index: 0,
    } as unknown as vscode.WorkspaceFolder;
}

function noopLogger(): Logger {
    return {
        trace() { }, debug() { }, info() { }, warn() { }, error() { },
        showInfo() { }, showError() { }, dispose() { },
    } as unknown as Logger;
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
} = {}): CeedlingEngine {
    return new CeedlingEngine(
        fakeWorkspaceFolder('/ws'),
        noopLogger(),
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
