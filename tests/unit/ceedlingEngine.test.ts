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

// Keyed by absolute path. A missing key simulates an ENOENT read failure.
function fakeReadFile(files: Record<string, string>): typeof fs.readFile {
    return ((filePath: string, _encoding: any, callback: any) => {
        if (Object.prototype.hasOwnProperty.call(files, filePath)) {
            callback(null, files[filePath]);
        } else {
            callback(Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' }), undefined);
        }
    }) as unknown as typeof fs.readFile;
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

function makeEngine(opts: {
    exec?: typeof child_process.exec,
    readFile?: typeof fs.readFile,
    settings?: Record<string, any>,
    isDevelopmentMode?: boolean,
} = {}): CeedlingEngine {
    return new CeedlingEngine(
        fakeWorkspaceFolder('/ws'),
        noopLogger(),
        opts.isDevelopmentMode ?? false,
        {
            configProvider: () => fakeConfig(opts.settings ?? {}),
            problemMatcher: fakeProblemMatcher(),
            exec: opts.exec,
            readFile: opts.readFile,
        },
    );
}

// Installs one project directly on the engine's private project map, bypassing
// loadProjectPaths() (which needs real fs.existsSync/lstatSync this seam doesn't cover).
function withProject(engine: CeedlingEngine, key: string, data: { absPath: string, ymlFileName: string }) {
    (engine as any).projectData = {
        [key]: { debugLaunchConfig: 'ceedling', projectPath: '.', files: {}, ...data },
    };
}

suite('getYmlProjectData (project.yml only, no mixin)', () => {
    test('parses the file and resolves the plain object', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({ '/ws/proj/project.yml': ':project:\n  :build_root: build\n' }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        assert.deepStrictEqual(result, { ':project': { ':build_root': 'build' } });
    });

    test('resolves undefined when the file cannot be read', async () => {
        const engine = makeEngine({ readFile: fakeReadFile({}) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        assert.strictEqual(result, undefined);
    });

    test('resolves undefined when the file fails to parse', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({ '/ws/proj/project.yml': ':project: [\n  broken' }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        assert.strictEqual(result, undefined);
    });

    // Current quirk, not a design choice: an empty project.yml parses to `undefined` (js-yaml's
    // safeLoad on empty input), and nothing here guards it back to `{}` on this code path.
    test('quirk: an empty project.yml resolves undefined, not {}', async () => {
        const engine = makeEngine({ readFile: fakeReadFile({ '/ws/proj/project.yml': '' }) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        assert.strictEqual(result, undefined);
    });
});

suite('getYmlProjectData -> mergeYmlProjectData (project points at an alternate/mixin yml)', () => {
    test('deep-merges the mixin over the base project.yml, mixin winning on scalar conflicts', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({
                '/ws/proj/mixin.yml': ':project:\n  :build_root: mixin_build\n:plugins:\n  :enabled:\n    - mixin_plugin\n',
                '/ws/proj/project.yml': ':project:\n  :build_root: base_build\n  :test_file_prefix: test_\n:plugins:\n  :enabled:\n    - base_plugin\n',
            }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'mixin.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        // Scalar: mixin's value replaces the base's.
        assert.strictEqual(result[':project'][':build_root'], 'mixin_build');
        // Untouched base key survives the merge.
        assert.strictEqual(result[':project'][':test_file_prefix'], 'test_');
        // Lists concatenate base-then-mixin; deepmerge does not de-duplicate or reorder.
        assert.deepStrictEqual(result[':plugins'][':enabled'], ['base_plugin', 'mixin_plugin']);
    });

    test('resolves the mixin alone when the base project.yml cannot be read', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({ '/ws/proj/mixin.yml': ':project:\n  :build_root: mixin_build\n' }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'mixin.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        assert.deepStrictEqual(result, { ':project': { ':build_root': 'mixin_build' } });
    });

    test('resolves undefined when the mixin itself cannot be read (base is never even attempted)', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({ '/ws/proj/project.yml': ':project:\n  :build_root: base_build\n' }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'mixin.yml' });
        const result = await (engine as any).getYmlProjectData('proj');
        assert.strictEqual(result, undefined);
    });
});

suite('checkYmlProjectData', () => {
    test('reports a load failure, referencing the settings name as it stands today (a known-wrong name)', async () => {
        const engine = makeEngine({ readFile: fakeReadFile({}) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const error = await (engine as any).checkYmlProjectData('proj');
        // Characterizes the pre-existing bug: the real setting is `ceedlingExplorer.projects`,
        // not `ceedlingExplorer.projectPath`. The upcoming rewrite corrects this message.
        assert.match(error, /ceedlingExplorer\.projectPath/);
    });

    test('reports the plugin-not-enabled error when report_tests_log_factory is missing', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({ '/ws/proj/project.yml': ':plugins:\n  :enabled:\n    - other_plugin\n' }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        const error = await (engine as any).checkYmlProjectData('proj');
        assert.match(error, /report_tests_log_factory.*is not enabled/);
    });

    test('reports nothing when report_tests_log_factory is enabled', async () => {
        const engine = makeEngine({
            readFile: fakeReadFile({ '/ws/proj/project.yml': ':plugins:\n  :enabled:\n    - report_tests_log_factory\n' }),
        });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
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

    test('once version-checked, a default project.yml gets --project (and cwd set) - note the doubled space, a pre-existing quirk of building the flags as one pre-spaced string', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'project.yml' });
        (engine as any).ceedlingVersionChecked = true;
        await (engine as any).execCeedling(['test:all'], 'proj');
        assert.strictEqual(calls[0].command, 'ceedling test:all  --project project.yml');
        assert.strictEqual(calls[0].options.cwd, '/ws/proj');
    });

    test('an alternate/mixin yml file name adds a single --mixin flag after --project', async () => {
        const calls: { command: string, options: any }[] = [];
        const engine = makeEngine({ exec: fakeExec(calls) });
        withProject(engine, 'proj', { absPath: '/ws/proj', ymlFileName: 'ci.yml' });
        (engine as any).ceedlingVersionChecked = true;
        await (engine as any).execCeedling(['test:all'], 'proj');
        assert.strictEqual(calls[0].command, 'ceedling test:all  --project project.yml --mixin ci.yml');
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
