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
        assert.deepStrictEqual(coverageStates(dumpconfigFixture('manual-project-with-bundled-mixin.yml')), { gcov: undefined, bullseye: undefined });
        assert.deepStrictEqual(coverageStates(undefined), { gcov: undefined, bullseye: undefined });
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
            { gcov: { reportTask: true, coberturaReports: [GCOVR] }, bullseye: undefined });
    });
});

// Ceedling's Bullseye plugin writes Cobertura through covxml only with `:xml_report: :cobertura`.
// `:native` writes Bullseye's own XML to the same file. The fixtures are real `dumpconfig` output
// (see tests/fixtures/capture/capture-bullseye.sh).
suite('coverageStates for Bullseye', () => {
    const resolved = (name: string) => dumpconfigFixture(`dumpconfig-bullseye-${name}.yml`, 'ceedling-1.2.2');
    const bullseye = (name: string) => coverageStates(resolved(name)).bullseye;
    const REPORT = 'artifacts/bullseye/coverage.xml';

    test('the Bullseye plugin with no XML report configured writes no Cobertura report', () => {
        assert.deepStrictEqual(coverageStates(resolved('default')), { gcov: undefined, bullseye: { reportTask: false, coberturaReports: [] } });
    });

    test('its Cobertura report lands in its artifacts', () => {
        assert.deepStrictEqual(bullseye('cobertura'), { reportTask: false, coberturaReports: [REPORT] });
    });

    test("its native report is Bullseye's own XML, which isn't Cobertura", () => {
        assert.deepStrictEqual(bullseye('native'), { reportTask: false, coberturaReports: [] });
    });

    test('reports may be deferred to the report:bullseye task', () => {
        assert.deepStrictEqual(bullseye('task'), { reportTask: true, coberturaReports: [REPORT] });
    });

    test('a project may enable both plugins, each with its own reports', () => {
        assert.deepStrictEqual(coverageStates(resolved('both-plugins')), {
            gcov: { reportTask: false, coberturaReports: ['artifacts/gcov/gcovr/GcovCoverageCobertura.xml'] },
            bullseye: { reportTask: false, coberturaReports: [REPORT] },
        });
    });
});

suite('coverageProblem', () => {
    test('a Bullseye project writing no Cobertura report is told to choose it, and where Bullseye is explained', () => {
        const problem = coverageProblem('fw', 'bullseye', { reportTask: false, coberturaReports: [] });
        assert.match(problem ?? '', /'fw'.*Cobertura/);
        assert.match(problem ?? '', /:bullseye: ↳ :xml_report: to :cobertura/);
        assert.match(problem ?? '', /latest\/manual\/code-coverage\/bullseye\/#what-bullseye-coverage-needs/);
    });

    test('a gcov project writing no Cobertura report is told how to add one', () => {
        const problem = coverageProblem('fw', 'gcov', { reportTask: false, coberturaReports: [] });
        assert.match(problem ?? '', /'fw'/);
        assert.match(problem ?? '', /Cobertura/);
        assert.match(problem ?? '', /:gcov: ↳ :reports:/);
        assert.match(problem ?? '', /https:\/\/docs\.throwtheswitch\.org\/vscode-ceedling\/latest\/manual\/code-coverage\/gcov\/#what-gcov-coverage-needs/);
    });

    test('a project writing one has no problem', () => {
        assert.strictEqual(coverageProblem('fw', 'gcov', { reportTask: false, coberturaReports: ['artifacts/gcov/gcovr/GcovCoverageCobertura.xml'] }), undefined);
    });
});
