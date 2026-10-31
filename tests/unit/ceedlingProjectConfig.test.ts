import * as assert from 'assert';
import * as fs from 'fs';
import yaml from 'js-yaml';
import * as path from 'path';
import {
    CeedlingLoadError,
    coverageProblem,
    coverageState,
    loadFailureMessage,
    type ProjectSetting,
    projectsFromSettings,
    projectState,
} from '../../src/ceedlingProjectConfig';

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function dumpconfigFixture(name: string, directory = 'dumpconfig'): unknown {
    return yaml.safeLoad(fs.readFileSync(path.resolve(fixturesRoot, directory, name), 'utf8'));
}

const anyDirectory = async () => true;
const noFiles = async () => false;
// A filesystem where exactly the listed files exist.
const filesAt = (...files: string[]) => async (p: string) => files.includes(p);

suite('projectsFromSettings', () => {
    test('with no projects configured, one default project sits at the workspace root', async () => {
        const projects = await projectsFromSettings({ projects: [], mixins: ['gcc'] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual(projects, [{
            key: 'default', absPath: '/ws', projectFileName: 'project.yml', ymlFileName: 'project.yml',
            ambiguousProjectFile: false, debugLaunchConfig: 'ceedling', mixins: ['gcc'],
        }]);
    });

    test('a directory path is keyed by that path and uses project.yml', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw/app', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual(project, {
            key: 'fw/app', absPath: '/ws/fw/app', projectFileName: 'project.yml', ymlFileName: 'project.yml',
            ambiguousProjectFile: false, debugLaunchConfig: 'dbg', mixins: [],
        });
    });

    test('an alternate yml path is keyed by its file name and resolves to its directory', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw/ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.strictEqual(project.key, 'ci');
        assert.strictEqual(project.ymlFileName, 'ci.yml');
        assert.strictEqual(project.absPath, '/ws/fw');
    });

    test('a yml path at the workspace root resolves to the root', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.strictEqual(project.absPath, '/ws');
    });

    test('an explicit project.yml path keeps the configured path as its key', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw/project.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.strictEqual(project.key, 'fw/project.yml');
        assert.strictEqual(project.ymlFileName, 'project.yml');
        assert.strictEqual(project.absPath, '/ws/fw');
    });

    // As for mixins, which Ceedling loads by path whatever their extension's spelling.
    test('a .yaml path, in any case, names a project file too', async () => {
        const [yamlFile, upper] = await projectsFromSettings({
            projects: [{ path: 'fw/ci.yaml', debugLaunchConfig: 'dbg' }, { path: 'fw/SIM.YML', debugLaunchConfig: 'dbg' }], mixins: [],
        }, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual([yamlFile.key, yamlFile.ymlFileName, yamlFile.absPath], ['ci', 'ci.yaml', '/ws/fw']);
        assert.deepStrictEqual([upper.key, upper.ymlFileName, upper.absPath], ['SIM', 'SIM.YML', '/ws/fw']);
    });

    // Settings are user JSON, typed only by package.json's schema, which VS Code doesn't enforce.
    test('a malformed setting is a load error naming it', async () => {
        const malformed: Array<[unknown, unknown, RegExp]> = [
            ['fw', [], /ceedlingExplorer\.projects must be a list/],
            [[{ path: 5, debugLaunchConfig: 'dbg' }], [], /ceedlingExplorer\.projects\[0\]\.path must be a string/],
            [[{ path: 'fw', debugLaunchConfig: 3 }], [], /ceedlingExplorer\.projects\[0\]\.debugLaunchConfig must be a string/],
            [[{ path: 'fw', debugLaunchConfig: 'dbg', name: 7 }], [], /ceedlingExplorer\.projects\[0\]\.name must be a string/],
            [[{ path: 'fw', debugLaunchConfig: 'dbg', mixins: 'gcc' }], [], /ceedlingExplorer\.projects\[0\]\.mixins must be a list of strings/],
            [[], 'gcc', /ceedlingExplorer\.mixins must be a list of strings/],
            [[], ['gcc', 3], /ceedlingExplorer\.mixins must be a list of strings/],
        ];
        for (const [projects, mixins, expected] of malformed) {
            // eslint-disable-next-line no-await-in-loop -- one case at a time, for its message
            await assert.rejects(projectsFromSettings({ projects, mixins } as unknown as Parameters<typeof projectsFromSettings>[0], '/ws', 'linux', anyDirectory, noFiles),
                (e: unknown) => e instanceof CeedlingLoadError && expected.test(e.message), `${JSON.stringify(projects)} ${JSON.stringify(mixins)}`);
        }
    });

    // Only debugging needs a launch configuration, and a project without mixins takes the global ones.
    test('a project may leave out its launch configuration and its mixins', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw', mixins: null }] as unknown as ProjectSetting[], mixins: ['gcc'] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual([project.key, project.mixins], ['fw', ['gcc']]);
    });

    // A case-insensitive filesystem reads Project.yml as project.yml, so it is the base, not a mixin over itself.
    test('a default project file named in another case is the base where the filesystem folds case', async () => {
        const settings = { projects: [{ path: 'fw/Project.yml', debugLaunchConfig: 'dbg' }], mixins: [] };
        const [folded] = await projectsFromSettings(settings, '/ws', 'darwin', anyDirectory, noFiles);
        assert.deepStrictEqual([folded.projectFileName, folded.ymlFileName, folded.key], ['Project.yml', 'Project.yml', 'fw/Project.yml']);
        const [exact] = await projectsFromSettings(settings, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual([exact.projectFileName, exact.ymlFileName, exact.key], ['project.yml', 'Project.yml', 'Project']);
    });

    test('backslash separators in a yml path are understood', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw\\ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.strictEqual(project.ymlFileName, 'ci.yml');
        assert.strictEqual(project.absPath, '/ws/fw');
    });

    test('a name overrides the derived key', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw/ci.yml', debugLaunchConfig: 'dbg', name: 'Firmware' }], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.strictEqual(project.key, 'Firmware');
    });

    test("a project's own mixins replace the workspace list; an explicit [] opts out of it", async () => {
        const projects = await projectsFromSettings({
            projects: [
                { path: 'a', debugLaunchConfig: 'dbg' },
                { path: 'b', debugLaunchConfig: 'dbg', mixins: ['clang'] },
                { path: 'c', debugLaunchConfig: 'dbg', mixins: [] },
            ],
            mixins: ['gcc'],
        }, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual(projects.map((p) => p.mixins), [['gcc'], ['clang'], []]);
    });

    test('a path that is not a directory is a load error naming it', async () => {
        await assert.rejects(
            projectsFromSettings({ projects: [{ path: 'missing', debugLaunchConfig: 'dbg' }], mixins: [] }, '/ws', 'linux', async () => false, noFiles),
            (e: unknown) => e instanceof CeedlingLoadError && /\/ws\/missing/.test(e.message),
        );
    });

    // Gcov's XML report generation needs an uppercase drive letter on Windows.
    test('on Windows the workspace drive letter is uppercased', async () => {
        const [project] = await projectsFromSettings({ projects: [], mixins: [] }, 'c:\\ws', 'win32', anyDirectory, noFiles);
        assert.match(project.absPath, /^C:/);
    });

    test('on Windows an absolute project path gets an uppercase drive letter too', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'c:\\ws\\fw', debugLaunchConfig: 'dbg' }], mixins: [] }, 'c:\\ws', 'win32', anyDirectory, noFiles);
        assert.strictEqual(project.absPath, 'C:\\ws\\fw');
    });

    test('the settings objects are not modified', async () => {
        const setting = { path: 'fw/ci.yml', debugLaunchConfig: 'dbg' };
        await projectsFromSettings({ projects: [setting], mixins: [] }, '/ws', 'linux', anyDirectory, noFiles);
        assert.deepStrictEqual(setting, { path: 'fw/ci.yml', debugLaunchConfig: 'dbg' });
    });
});

// Ceedling 1.2.0 also loads ceedling.yml as a project's default project file.
suite('projectsFromSettings: the default project file', () => {
    test('a directory holding only ceedling.yml uses it', async () => {
        const [project] = await projectsFromSettings({ projects: [], mixins: [] }, '/ws', 'linux', anyDirectory, filesAt('/ws/ceedling.yml'));
        assert.strictEqual(project.projectFileName, 'ceedling.yml');
        assert.strictEqual(project.ymlFileName, 'ceedling.yml');
        assert.strictEqual(project.ambiguousProjectFile, false);
    });

    test('a directory holding both uses project.yml and flags the ambiguity', async () => {
        const [project] = await projectsFromSettings({ projects: [], mixins: [] }, '/ws', 'linux', anyDirectory, filesAt('/ws/project.yml', '/ws/ceedling.yml'));
        assert.strictEqual(project.projectFileName, 'project.yml');
        assert.strictEqual(project.ambiguousProjectFile, true);
    });

    test('an alternate project file applies over a ceedling.yml base', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw/ci.yml', debugLaunchConfig: 'dbg' }], mixins: [] },
            '/ws', 'linux', anyDirectory, filesAt('/ws/fw/ceedling.yml', '/ws/fw/ci.yml'));
        assert.strictEqual(project.projectFileName, 'ceedling.yml');
        assert.strictEqual(project.ymlFileName, 'ci.yml');
    });

    test('an explicit ceedling.yml path is the project file itself, keyed by its path', async () => {
        const [project] = await projectsFromSettings({ projects: [{ path: 'fw/ceedling.yml', debugLaunchConfig: 'dbg' }], mixins: [] },
            '/ws', 'linux', anyDirectory, filesAt('/ws/fw/ceedling.yml'));
        assert.strictEqual(project.key, 'fw/ceedling.yml');
        assert.strictEqual(project.projectFileName, 'ceedling.yml');
        assert.strictEqual(project.ymlFileName, 'ceedling.yml');
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
                coverage: undefined,
                testPaths: [],
                whichCeedling: 'gem',
            });
        }
    });

    test('the test paths are read as configured, decorators and globs included', () => {
        assert.deepStrictEqual(projectState({ ':paths': { ':test': ['+:test/**', '-:test/support', 7] } }, 'linux').testPaths, ['+:test/**', '-:test/support']);
        assert.deepStrictEqual(projectState(dumpconfigFixture('dumpconfig-gcov-default.yml', 'ceedling-1.2.0'), 'linux').testPaths, ['+:test/**']);
    });

    // The installed gem's Ceedling, unless the project selects another, which `ceedling version` can't see.
    test('the Ceedling a project selects is the gem by default, as dumpconfig shows it', () => {
        assert.strictEqual(projectState(dumpconfigFixture('dumpconfig-stdout.yml', 'ceedling-1.2.0'), 'linux').whichCeedling, 'gem');
        assert.strictEqual(projectState({ ':project': { ':which_ceedling': '../tools/ceedling' } }, 'linux').whichCeedling, '../tools/ceedling');
    });

    test('the default executable extension is .exe on Windows', () => {
        assert.strictEqual(projectState({}, 'win32').executableExtension, '.exe');
    });

    test('each setting is read from its Ceedling configuration path', () => {
        const state = projectState({
            ':project': { ':build_root': 'out', ':test_file_prefix': 'check_', ':which_ceedling': 'vendor/ceedling' },
            ':test_runner': { ':test_prefix': 'check' },
            ':extension': { ':executable': '.bin' },
            ':unity': { ':use_param_tests': true },
            ':plugins': { ':enabled': ['report_tests_log_factory'] },
            ':report_tests_log_factory': { ':cppunit': { ':filename': 'mine.xml' } },
            ':paths': { ':test': ['spec/**'] },
        }, 'linux');
        assert.deepStrictEqual(state, {
            buildRoot: 'out',
            reportFilename: 'mine.xml',
            testPrefix: 'check',
            testFilePrefix: 'check_',
            executableExtension: '.bin',
            useParamTests: true,
            reportPluginEnabled: true,
            coverage: undefined,
            testPaths: ['spec/**'],
            whichCeedling: 'vendor/ceedling',
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

    // Captured with `ceedling dumpconfig --stdout` from Ceedling 1.2.0, against tests/manual plus the bundled mixin.
    test('real Ceedling 1.2.0 `dumpconfig --stdout` output reads as the manual project', () => {
        const resolved = yaml.safeLoad(fs.readFileSync(path.resolve(fixturesRoot, 'ceedling-1.2.0', 'dumpconfig-stdout.yml'), 'utf8'));
        const state = projectState(resolved, 'linux');
        assert.strictEqual(state.reportPluginEnabled, true);
        assert.strictEqual(state.useParamTests, true);
        assert.strictEqual(state.testFilePrefix, 'test_');
        assert.strictEqual(state.executableExtension, '.out');
    });

    test('real dumpconfig output with the bundled mixin has the report plugin and default report name', () => {
        const state = projectState(dumpconfigFixture('manual-project-with-bundled-mixin.yml'), 'linux');
        assert.strictEqual(state.reportPluginEnabled, true);
        assert.strictEqual(state.reportFilename, 'cppunit_tests_report.xml');
        assert.strictEqual(state.buildRoot, 'build');
        assert.strictEqual(state.useParamTests, true);
    });
});

// Ceedling's gcov plugin writes Cobertura through gcovr, ReportGenerator, or both. The resolved
// configuration names which, and where. The fixtures are real `dumpconfig` output with the
// plugin's defaults merged in (see tests/fixtures/capture/capture-gcov.sh).
suite('coverageState', () => {
    const gcov = (name: string) => coverageState(dumpconfigFixture(`dumpconfig-gcov-${name}.yml`, 'ceedling-1.2.0'));
    const GCOVR = 'artifacts/gcov/gcovr/GcovCoverageCobertura.xml';
    const REPORT_GENERATOR = ['artifacts/gcov/ReportGenerator/Cobertura.xml', 'artifacts/gcov/ReportGenerator/Cobertura/Cobertura.xml'];

    test('a project without the gcov plugin has no coverage', () => {
        assert.strictEqual(coverageState(dumpconfigFixture('manual-project-with-bundled-mixin.yml')), undefined);
    });

    test('the gcov plugin with no reports configured writes no Cobertura report', () => {
        assert.deepStrictEqual(gcov('default'), { reportTask: false, coberturaReports: [] });
    });

    // ReportGenerator nests its Cobertura report in a subdirectory when it writes several report types.
    test("with both utilities, gcovr's report comes first, then each place ReportGenerator may write its own", () => {
        assert.deepStrictEqual(gcov('both-utilities'), { reportTask: false, coberturaReports: [GCOVR, ...REPORT_GENERATOR] });
    });

    test("gcovr's report may be renamed", () => {
        assert.deepStrictEqual(gcov('cobertura-filename'), { reportTask: false, coberturaReports: ['artifacts/gcov/gcovr/Custom.xml'] });
    });

    test('reports may be deferred to the report:gcov task', () => {
        assert.deepStrictEqual(gcov('report-task'), { reportTask: true, coberturaReports: [GCOVR] });
    });

    test('utility and report names match whatever their case, as Ceedling matches them', () => {
        const resolved = { ':plugins': { ':enabled': ['gcov'] }, ':gcov': { ':utilities': ['reportgenerator'], ':reports': ['COBERTURA'] } };
        assert.deepStrictEqual(coverageState(resolved), { reportTask: false, coberturaReports: REPORT_GENERATOR });
    });

    test('with no utilities listed, gcovr writes the reports', () => {
        const resolved = { ':plugins': { ':enabled': ['gcov'] }, ':gcov': { ':reports': ['Cobertura'] } };
        assert.deepStrictEqual(coverageState(resolved), { reportTask: false, coberturaReports: [GCOVR] });
    });

    test('the project state carries it', () => {
        assert.deepStrictEqual(projectState(dumpconfigFixture('dumpconfig-gcov-report-task.yml', 'ceedling-1.2.0'), 'linux').coverage,
            { reportTask: true, coberturaReports: [GCOVR] });
    });
});

suite('coverageProblem', () => {
    test('a project writing no Cobertura report is told how to add one', () => {
        const problem = coverageProblem('fw', { reportTask: false, coberturaReports: [] });
        assert.match(problem ?? '', /'fw'/);
        assert.match(problem ?? '', /Cobertura/);
        assert.match(problem ?? '', /:reports:/);
    });

    test('a project writing one has no problem', () => {
        assert.strictEqual(coverageProblem('fw', { reportTask: false, coberturaReports: ['artifacts/gcov/gcovr/GcovCoverageCobertura.xml'] }), undefined);
    });
});

suite('loadFailureMessage', () => {
    test("a load error is shown and logged as its own message", () => {
        assert.deepStrictEqual(loadFailureMessage(new CeedlingLoadError('Ceedling 0.31.1 is not supported.')),
            { notice: 'Ceedling 0.31.1 is not supported.', log: 'Ceedling 0.31.1 is not supported.' });
    });

    // A notification is no place for a stack trace, while the log keeps it for a bug report.
    test('another failure shows its message, and logs its stack', () => {
        const error = new TypeError('boom');
        const { notice, log } = loadFailureMessage(error);
        assert.strictEqual(notice, 'Failed to load Ceedling project: boom');
        assert.ok(log.startsWith('Failed to load Ceedling project: TypeError: boom\n'), log);
        assert.strictEqual(loadFailureMessage('odd').notice, 'Failed to load Ceedling project: odd');
    });
});
