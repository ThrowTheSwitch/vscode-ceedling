import * as assert from 'assert';
import * as fs from 'fs';
import yaml from 'js-yaml';
import * as path from 'path';
import { CeedlingLoadError, projectState, projectsFromSettings } from '../../src/ceedlingProjectConfig';

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function dumpconfigFixture(name: string): unknown {
    return yaml.safeLoad(fs.readFileSync(path.resolve(fixturesRoot, 'dumpconfig', name), 'utf8'));
}

const anyDirectory = () => true;

suite('projectsFromSettings', () => {
    test('with no projects configured, one default project sits at the workspace root', () => {
        const projects = projectsFromSettings({ projects: [], mixins: ['gcc'] }, '/ws', 'linux', anyDirectory);
        assert.deepStrictEqual(projects, [
            { key: 'default', absPath: '/ws', ymlFileName: 'project.yml', debugLaunchConfig: 'ceedling', mixins: ['gcc'] },
        ]);
    });

    test('a directory path is keyed by that path and uses project.yml', () => {
        const [project] = projectsFromSettings({ projects: [{ path: 'fw/app', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.deepStrictEqual(project, { key: 'fw/app', absPath: '/ws/fw/app', ymlFileName: 'project.yml', debugLaunchConfig: 'dbg', mixins: [] });
    });

    test('an alternate yml path is keyed by its file name and resolves to its directory', () => {
        const [project] = projectsFromSettings({ projects: [{ path: 'fw/ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.strictEqual(project.key, 'ci');
        assert.strictEqual(project.ymlFileName, 'ci.yml');
        assert.strictEqual(project.absPath, '/ws/fw');
    });

    test('a yml path at the workspace root resolves to the root', () => {
        const [project] = projectsFromSettings({ projects: [{ path: 'ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.strictEqual(project.absPath, '/ws');
    });

    test('an explicit project.yml path keeps the configured path as its key', () => {
        const [project] = projectsFromSettings({ projects: [{ path: 'fw/project.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.strictEqual(project.key, 'fw/project.yml');
        assert.strictEqual(project.ymlFileName, 'project.yml');
        assert.strictEqual(project.absPath, '/ws/fw');
    });

    test('backslash separators in a yml path are understood', () => {
        const [project] = projectsFromSettings({ projects: [{ path: 'fw\\ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.strictEqual(project.ymlFileName, 'ci.yml');
        assert.strictEqual(project.absPath, '/ws/fw');
    });

    test('a name overrides the derived key', () => {
        const [project] = projectsFromSettings({ projects: [{ path: 'fw/ci.yml', debugLaunchConfig: 'dbg', name: 'Firmware' }], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.strictEqual(project.key, 'Firmware');
    });

    test("a project's own mixins replace the workspace list; an explicit [] opts out of it", () => {
        const projects = projectsFromSettings({
            projects: [
                { path: 'a', debugLaunchConfig: 'dbg' },
                { path: 'b', debugLaunchConfig: 'dbg', mixins: ['clang'] },
                { path: 'c', debugLaunchConfig: 'dbg', mixins: [] },
            ],
            mixins: ['gcc'],
        }, '/ws', 'linux', anyDirectory);
        assert.deepStrictEqual(projects.map((p) => p.mixins), [['gcc'], ['clang'], []]);
    });

    test('a path that is not a directory is a load error naming it', () => {
        assert.throws(
            () => projectsFromSettings({ projects: [{ path: 'missing', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', () => false),
            (e: unknown) => e instanceof CeedlingLoadError && /\/ws\/missing/.test(e.message),
        );
    });

    // Gcov's XML report generation needs an uppercase drive letter on Windows.
    test('on Windows the workspace drive letter is uppercased', () => {
        const [project] = projectsFromSettings({ projects: [], mixins: [] }, 'c:\\ws', 'win32', anyDirectory);
        assert.match(project.absPath, /^C:/);
    });

    test('the settings objects are not modified', () => {
        const setting = { path: 'fw/ci.yml', debugLaunchConfig: 'dbg' };
        projectsFromSettings({ projects: [setting], mixins: [] }, '/ws', 'linux', anyDirectory);
        assert.deepStrictEqual(setting, { path: 'fw/ci.yml', debugLaunchConfig: 'dbg' });
    });
});

suite('projectState', () => {
    test('an empty or missing resolved config falls back to Ceedling defaults', () => {
        for (const resolved of [undefined, {}, { ':project': null }]) {
            assert.deepStrictEqual(projectState(resolved, 'linux'), {
                buildRoot: 'build',
                reportFilename: 'cppunit_tests_report.xml',
                testPrefix: 'test|spec|should',
                testFilePrefix: 'test_',
                executableExtension: '.out',
                useParamTests: false,
                reportPluginEnabled: false,
            });
        }
    });

    test('the default executable extension is .exe on Windows', () => {
        assert.strictEqual(projectState({}, 'win32').executableExtension, '.exe');
    });

    test('each setting is read from its Ceedling configuration path', () => {
        const state = projectState({
            ':project': { ':build_root': 'out', ':test_file_prefix': 'check_' },
            ':test_runner': { ':test_prefix': 'check' },
            ':extension': { ':executable': '.bin' },
            ':unity': { ':use_param_tests': true },
            ':plugins': { ':enabled': ['report_tests_log_factory'] },
            ':report_tests_log_factory': { ':cppunit': { ':filename': 'mine.xml' } },
        }, 'linux');
        assert.deepStrictEqual(state, {
            buildRoot: 'out',
            reportFilename: 'mine.xml',
            testPrefix: 'check',
            testFilePrefix: 'check_',
            executableExtension: '.bin',
            useParamTests: true,
            reportPluginEnabled: true,
        });
    });

    // :unity: :test_prefix: was never a real Ceedling setting.
    test(':unity: :test_prefix: is not read', () => {
        assert.strictEqual(projectState({ ':unity': { ':test_prefix': 'legacy' } }, 'linux').testPrefix, 'test|spec|should');
    });

    test('a value of the wrong type falls back to its default', () => {
        const state = projectState({ ':project': { ':build_root': 42 }, ':plugins': { ':enabled': 'report_tests_log_factory' } }, 'linux');
        assert.strictEqual(state.buildRoot, 'build');
        assert.strictEqual(state.reportPluginEnabled, false);
    });

    // Real `ceedling dumpconfig` output, captured against tests/manual (see fixtures/dumpconfig).
    test('real dumpconfig output without the bundled mixin lacks the report plugin', () => {
        assert.strictEqual(projectState(dumpconfigFixture('manual-project-no-report-plugin.yml'), 'linux').reportPluginEnabled, false);
    });

    test('real dumpconfig output with the bundled mixin has the report plugin and default report name', () => {
        const state = projectState(dumpconfigFixture('manual-project-with-bundled-mixin.yml'), 'linux');
        assert.strictEqual(state.reportPluginEnabled, true);
        assert.strictEqual(state.reportFilename, 'cppunit_tests_report.xml');
        assert.strictEqual(state.buildRoot, 'build');
        assert.strictEqual(state.useParamTests, true);
    });
});
