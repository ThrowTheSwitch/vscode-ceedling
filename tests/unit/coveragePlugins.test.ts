import * as assert from 'assert';
import * as fs from 'fs';
import yaml from 'js-yaml';
import * as path from 'path';
import { projectState } from '../../src/ceedlingProjectConfig';
import { coverageProblem, coverageStates } from '../../src/coveragePlugins';

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function dumpconfigFixture(name: string, directory = 'dumpconfig'): unknown {
    return yaml.safeLoad(fs.readFileSync(path.resolve(fixturesRoot, directory, name), 'utf8'));
}

// Ceedling's gcov plugin writes Cobertura through gcovr, ReportGenerator, or both. The resolved
// configuration names which, and where. The fixtures are real `dumpconfig` output with the
// plugin's defaults merged in (see tests/fixtures/capture/capture-gcov.sh).
suite('coverageStates for gcov', () => {
    const gcov = (name: string) => coverageStates(dumpconfigFixture(`dumpconfig-gcov-${name}.yml`, 'ceedling-1.2.0')).gcov;
    const GCOVR = 'artifacts/gcov/gcovr/GcovCoverageCobertura.xml';
    const REPORT_GENERATOR = ['artifacts/gcov/ReportGenerator/Cobertura.xml', 'artifacts/gcov/ReportGenerator/Cobertura/Cobertura.xml'];

    test('a project without a coverage plugin has no coverage', () => {
        assert.deepStrictEqual(coverageStates(dumpconfigFixture('manual-project-with-bundled-mixin.yml')), { gcov: undefined });
        assert.deepStrictEqual(coverageStates(undefined), { gcov: undefined });
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
        assert.deepStrictEqual(coverageStates(resolved).gcov, { reportTask: false, coberturaReports: REPORT_GENERATOR });
    });

    test('with no utilities listed, gcovr writes the reports', () => {
        const resolved = { ':plugins': { ':enabled': ['gcov'] }, ':gcov': { ':reports': ['Cobertura'] } };
        assert.deepStrictEqual(coverageStates(resolved).gcov, { reportTask: false, coberturaReports: [GCOVR] });
    });

    test('the project state carries it', () => {
        assert.deepStrictEqual(projectState(dumpconfigFixture('dumpconfig-gcov-report-task.yml', 'ceedling-1.2.0'), 'linux').coverage,
            { gcov: { reportTask: true, coberturaReports: [GCOVR] } });
    });
});

suite('coverageProblem', () => {
    test('a gcov project writing no Cobertura report is told how to add one', () => {
        const problem = coverageProblem('fw', 'gcov', { reportTask: false, coberturaReports: [] });
        assert.match(problem ?? '', /'fw'/);
        assert.match(problem ?? '', /Cobertura/);
        assert.match(problem ?? '', /:gcov: ↳ :reports:/);
        assert.match(problem ?? '', /https:\/\/docs\.throwtheswitch\.org\/vscode-ceedling\/latest\/manual\/code-coverage\//);
    });

    test('a project writing one has no problem', () => {
        assert.strictEqual(coverageProblem('fw', 'gcov', { reportTask: false, coberturaReports: ['artifacts/gcov/gcovr/GcovCoverageCobertura.xml'] }), undefined);
    });
});
