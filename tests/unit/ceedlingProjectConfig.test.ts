import * as assert from 'assert';
import * as fs from 'fs';
import yaml from 'js-yaml';
import * as path from 'path';
import {
    applicationRelease, capabilitiesOf, type CeedlingFeature, ceedlingRelease, CeedlingLoadError, firstRelease, isSupportedRelease, MINIMUM_CEEDLING_VERSION,
    coverageProblem, coverageState, pathKey, projectState, projectsFromSettings, testBuildName, versionSeesSelection,
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

suite('Ceedling releases', () => {
    // Real builds report a commit suffix, e.g. 1.2.0-13a540f, which semver ranks below 1.2.0.
    test('a reported version counts as its release, build suffix and all', () => {
        assert.deepStrictEqual(['1.2.0', '1.2.0-13a540f', '1.2.1.dev', 'v1.1.10'].map(ceedlingRelease), ['1.2.0', '1.2.0', '1.2.1', '1.1.10']);
    });

    test('a version with no release in it has none', () => {
        assert.strictEqual(ceedlingRelease('unknown'), undefined);
    });

    test('releases from 1.0.0 are supported', () => {
        assert.strictEqual(MINIMUM_CEEDLING_VERSION, '1.0.0');
        assert.deepStrictEqual(['0.31.1', '1.0.0', '1.3.0'].map(isSupportedRelease), [false, true, true]);
    });

    test('each capability holds from its first release, and not in the release before', () => {
        assert.deepStrictEqual(firstRelease('pathQualifiedCoverageTasks'), '1.2.1');
        const previous: Record<string, string> = { '1.2.0': '1.1.10', '1.2.1': '1.2.0', '1.2.2': '1.2.1' };
        for (const feature of Object.keys(capabilitiesOf('1.0.0')) as CeedlingFeature[]) {
            const first = firstRelease(feature);
            assert.ok(first in previous, `${feature} from ${first}, a release this test doesn't know`);
            assert.strictEqual(capabilitiesOf(first)[feature], true, `${feature} at ${first}`);
            assert.strictEqual(capabilitiesOf(previous[first])[feature], false, `${feature} before ${first}`);
        }
    });

    test('a Ceedling that runs no other installation reports its own release exactly', () => {
        assert.deepStrictEqual(applicationRelease({ application: '1.2.0-13a540f' }), { release: '1.2.0', exactRelease: true });
    });

    // Before 1.2.2 a launcher reports another installation as its own release with that
    // installation's commit (Ceedling#1365). Only the same commit shows the same build.
    test('before Ceedling 1.2.2, a launcher reports another installation exactly only when it is the same build', () => {
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.1-47d2c5e', application: '1.2.1-47d2c5e' }), { release: '1.2.1', exactRelease: true });
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.1-47d2c5e', application: '1.2.1-13a540f' }), { release: '1.2.1', exactRelease: false });
        assert.deepStrictEqual(applicationRelease({ launcher: '1.1.10', application: '1.1.10' }), { release: '1.1.10', exactRelease: false });
    });

    test("from Ceedling 1.2.2, a launcher reports another installation's own release exactly", () => {
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.2-0a1b2c3', application: '1.2.0-13a540f' }), { release: '1.2.0', exactRelease: true });
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.2', application: '1.2.1' }), { release: '1.2.1', exactRelease: true });
    });

    test('a report naming no release for either Ceedling has none', () => {
        assert.strictEqual(applicationRelease({ application: 'unknown' }), undefined);
        assert.strictEqual(applicationRelease({ launcher: 'unknown', application: '1.2.0' }), undefined);
    });
});

suite('capabilitiesOf', () => {
    const none = {
        dumpconfigStdout: false, forceTestRerun: false, pathQualifiedTestTasks: false, pathQualifiedCoverageTasks: false, ceedlingYml: false, nestedTestBuilds: false,
        readOnlyDiscovery: false, reportsApplicationVersion: false,
    };

    test('Ceedling before 1.2.0 has none of the 1.2.0 features', () => {
        for (const version of ['1.0.0', '1.1.10', '1.1.10-85ec551']) {
            assert.deepStrictEqual(capabilitiesOf(version), none);
        }
    });

    // Real 1.2.0 builds report a commit suffix, e.g. 1.2.0-13a540f, which semver ranks below 1.2.0.
    // 1.2.0's gcov: tasks still take only a bare file name.
    test("Ceedling 1.2.0, build suffix included, has every 1.2.0 feature and none of 1.2.1's", () => {
        for (const version of ['1.2.0', '1.2.0-13a540f']) {
            assert.deepStrictEqual(capabilitiesOf(version), { ...none, dumpconfigStdout: true, forceTestRerun: true, pathQualifiedTestTasks: true, ceedlingYml: true, nestedTestBuilds: true });
        }
    });

    const v121 = { dumpconfigStdout: true, forceTestRerun: true, pathQualifiedTestTasks: true, pathQualifiedCoverageTasks: true, ceedlingYml: true, nestedTestBuilds: true, readOnlyDiscovery: true };

    test("Ceedling 1.2.1, build suffix included, also takes paths in coverage tasks and discovers without writing, but has none of 1.2.2's", () => {
        for (const version of ['1.2.1', '1.2.1-0a1b2c3']) {
            assert.deepStrictEqual(capabilitiesOf(version), { ...v121, reportsApplicationVersion: false });
        }
    });

    test("Ceedling 1.2.2 and later, build suffix included, also report another installation's version", () => {
        for (const version of ['1.2.2', '1.2.2-0a1b2c3', '1.3.1']) {
            assert.deepStrictEqual(capabilitiesOf(version), { ...v121, reportsApplicationVersion: true });
        }
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

// Two spellings of one Windows directory must share a lock, or their builds could overlap.
// Ceedling names a test's build for its file's directory within the longest test path holding it:
// PathMirror.relative_subdir in 1.2.0 and 1.2.1, over :paths: :test: stripped of decorators and globs.
// Before 1.2.2 `ceedling version` never reads :which_ceedling:, so its report covers a project only
// when the setting picks what `version` picks unaided: the installed gem, or vendor/ceedling.
suite('versionSeesSelection', () => {
    for (const which of ['gem', 'GEM', ' Gem ', 'vendor/ceedling', './vendor/ceedling/', 'vendor//ceedling', '/ws/vendor/ceedling']) {
        test(`'${which}' is seen`, () => assert.strictEqual(versionSeesSelection(which, '/ws', 'linux'), true));
    }
    for (const which of ['tools/ceedling', 'vendor/ceedling/sub', '../vendor/ceedling', '/opt/ceedling', 'VENDOR/ceedling', 'gems']) {
        test(`'${which}' isn't seen`, () => assert.strictEqual(versionSeesSelection(which, '/ws', 'linux'), false));
    }
    for (const which of ['vendor\\ceedling', 'Vendor\\Ceedling\\', 'c:\\ws\\vendor\\ceedling', 'C:/WS/vendor/ceedling']) {
        test(`on Windows, '${which}' is seen`, () => assert.strictEqual(versionSeesSelection(which, 'C:\\ws', 'win32'), true));
    }
});

suite('testBuildName', () => {
    const nested = (id: string, paths: string[]) => testBuildName(id, paths, true);

    test('before Ceedling 1.2.0, a test builds under its bare name', () => {
        assert.strictEqual(testBuildName('test/unit/test_calc.c', ['+:test/**'], false), 'test_calc');
    });

    test("from 1.2.0, a test builds under its directory within its test path, or its bare name at that path's root", () => {
        assert.strictEqual(nested('test/unit/test_calc.c', ['+:test/**']), 'unit/test_calc');
        assert.strictEqual(nested('test/test_calc.c', ['+:test/**']), 'test_calc');
        assert.strictEqual(nested('test/a/b/test_calc.cpp', ['test/**']), 'a/b/test_calc');
    });

    test('the longest test path holding the file decides, so the same files may build in either layout', () => {
        assert.strictEqual(nested('test/unit/test_calc.c', ['+:test/**', '+:test/unit/**']), 'test_calc');
        const files = ['test/unit/test_calc.c', 'extra/unit/test_calc.c'];
        assert.deepStrictEqual(files.map((f) => nested(f, ['+:test/unit/**', '+:extra/**'])), ['test_calc', 'unit/test_calc']);
        assert.deepStrictEqual(files.map((f) => nested(f, ['+:test/**', '+:extra/unit/**'])), ['unit/test_calc', 'test_calc']);
    });

    test('a test path is cut back to the directory before its first glob, and a subtractive one counts as well', () => {
        assert.strictEqual(nested('test/x/unit/test_calc.c', ['test/*/unit']), 'x/unit/test_calc');
        assert.strictEqual(nested('test/unit/test_calc.c', ['test/unit/']), 'test_calc');
        assert.strictEqual(nested('test/unit/test_calc.c', ['  +: test  ']), 'unit/test_calc');
        assert.strictEqual(nested('test/support/x/test_calc.c', ['+:test/**', '-:test/support']), 'x/test_calc');
    });

    test('a file under no usable test path builds under its bare name', () => {
        assert.strictEqual(nested('other/unit/test_calc.c', ['+:test/**']), 'test_calc');
        assert.strictEqual(nested('test/unit/test_calc.c', ['**/unit']), 'test_calc');
        assert.strictEqual(nested('test_calc.c', ['+:test/**']), 'test_calc');
    });

    // Ceedling cuts `/*` to the root directory `/`, which then holds nothing, as `//` starts no path.
    test('absolute test paths place absolute test files, and the filesystem root holds none', () => {
        assert.strictEqual(nested('/abs/test/unit/test_calc.c', ['+:/abs/test/**']), 'unit/test_calc');
        assert.strictEqual(nested('/unit/test_calc.c', ['/*']), 'test_calc');
    });

    test('backslashes in paths and ids read as separators, as Ceedling standardizes them', () => {
        assert.strictEqual(nested('test\\unit\\test_calc.c', ['+:test\\**']), 'unit/test_calc');
    });
});

suite('pathKey', () => {
    test('on Windows, spellings of one path differing only in case share a key', () => {
        assert.strictEqual(pathKey('C:\\Work\\FW', 'win32'), pathKey('c:\\work\\fw', 'win32'));
    });

    test('elsewhere, case distinguishes paths', () => {
        assert.notStrictEqual(pathKey('/work/FW', 'linux'), pathKey('/work/fw', 'linux'));
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
