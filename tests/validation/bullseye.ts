// Coverage against real Ceedling and a licensed Bullseye, which run.sh installs into this container
// for this run alone. One run at a time, it checks:
// - a first run builds the coverage file, with nothing to reset;
// - covclear resets it before each later request, and a delta build that compiles nothing then
//   measures only its own run;
// - measurements accumulate when resets are off;
// - a source above the project resolves to its own path;
// - a function run's whole-file fallback covers what the whole file does;
// - a project run, deferred reports, and a native report's configuration problem;
// - two projects in one directory share its coverage file and one reset per request.
//
// usage: node bullseye.js
import semver from 'semver';
import { coverageMode } from '../../src/coverageRun';
import { ceedlingVersion, describeOutcome, fileOf, hasCommand, hits, leftovers, logSummary, main, makeEngine, only, recordingReporter, stage, token, WS } from './harness';

main('bullseye', async (checks) => {
    // Earlier releases ship the plugin disabled.
    if (semver.lt(ceedlingVersion(), '1.2.0')) {
        console.log(`skipped: Ceedling ${ceedlingVersion()} has no Bullseye plugin`);
        return;
    }
    if (!hasCommand('covclear')) {
        throw new Error('no Bullseye on PATH; run this suite through `just validate-bullseye`');
    }
    stage('tests/validation/workspaces/bullseye');
    const cobertura = `${WS}/mixins/cobertura.yml`;
    const settings: Record<string, unknown> = { projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [cobertura], coverageResetsCounters: true };
    const { engine, logs } = makeEngine(settings);
    const project = only(await engine.discover());
    const calculator = fileOf(project, 'test/test_calculator.c'), clamp = fileOf(project, 'test/test_clamp.c');
    const resets = () => logs.filter((l) => /^coverageTool\(\w+\): covclear /.test(l.message)).length;
    const step = async (label: string, run: (reporter: ReturnType<typeof recordingReporter>) => Promise<void>, passing: string[]) => {
        const reporter = recordingReporter();
        const before = resets();
        await run(reporter);
        console.log(`${label}: ${reporter.outcomes.map(describeOutcome).join(' | ')}; ${resets() - before} reset(s)`);
        for (const id of passing) checks.expect(reporter.results.get(id) === 'passed', `${label}: ${id} ${reporter.results.get(id)}`);
        return { outcome: reporter.last(), resets: resets() - before };
    };
    const ADD = 'test/test_calculator.c::test_add', ADD_MORE = 'test/test_calculator.c::test_add_more', CLAMP = 'test/test_clamp.c::test_clamp_low';
    // Probe lines, as the captured reports show them: add's body, subtract's, and clamp's entry.
    const ADD_LINE = 4, SUBTRACT_LINE = 9, CLAMP_LINE = 4;

    let { outcome, resets: reset } = await step('B1 file, a first build', (r) => engine.runFile('project', calculator, r, token(), coverageMode('bullseye')), [ADD]);
    checks.expect(outcome?.kind === 'report' && outcome.path.endsWith('artifacts/bullseye/coverage.xml'), 'B1: expected the Bullseye report');
    checks.expect(hits(outcome, 'src/Calculator.c', ADD_LINE) === 1 && hits(outcome, 'src/Calculator.c', SUBTRACT_LINE) === 0, 'B1: Calculator.c hits');
    checks.expect(reset === 0, 'B1: no coverage file yet, so nothing to reset');

    ({ outcome, resets: reset } = await step('B2 the same file again, reset', (r) => engine.runFile('project', calculator, r, token(), coverageMode('bullseye')), [ADD]));
    checks.expect(reset === 1 && hits(outcome, 'src/Calculator.c', ADD_LINE) === 1, 'B2: one reset, then the run measured again');

    ({ outcome } = await step('B3 a file whose source is above the project, reset', (r) => engine.runFile('project', clamp, r, token(), coverageMode('bullseye')), [CLAMP]));
    checks.expect(hits(outcome, `${WS}/lib/Clamp.c`, CLAMP_LINE) === 1, 'B3: lib/Clamp.c at its own path');
    checks.expect(hits(outcome, 'src/Calculator.c', ADD_LINE) === 0, "B3: the reset cleared B2's measurements");

    settings.coverageResetsCounters = false;
    ({ outcome, resets: reset } = await step('B4 the other file, measurements kept', (r) => engine.runFile('project', calculator, r, token(), coverageMode('bullseye')), [ADD]));
    checks.expect(reset === 0 && hits(outcome, `${WS}/lib/Clamp.c`, CLAMP_LINE) === 1 && hits(outcome, 'src/Calculator.c', ADD_LINE) === 1, 'B4: both runs counted');
    settings.coverageResetsCounters = true;

    // --test-case=test_add also selects test_add_more, so the run falls back to the whole file.
    ({ outcome, resets: reset } = await step('B5 function, its whole-file fallback', (r) => engine.runFunction('project', calculator, calculator.functions[0], r, token(), coverageMode('bullseye')), [ADD, ADD_MORE]));
    checks.expect(reset === 1 && hits(outcome, 'src/Calculator.c', ADD_LINE) === 1 && hits(outcome, `${WS}/lib/Clamp.c`, CLAMP_LINE) === 0, 'B5: the fallback covers what the whole file does');

    ({ outcome } = await step('B6 project', (r) => engine.runProjectAll('project', project.files, r, token(), coverageMode('bullseye')), [ADD, CLAMP]));
    checks.expect(hits(outcome, 'src/Calculator.c', ADD_LINE) === 1 && hits(outcome, `${WS}/lib/Clamp.c`, CLAMP_LINE) === 1, 'B6: both sources');

    settings.mixins = [`${WS}/mixins/task.yml`];
    only(await engine.discover());
    ({ outcome } = await step('B7 file, reports deferred to report:bullseye', (r) => engine.runFile('project', calculator, r, token(), coverageMode('bullseye')), [ADD]));
    checks.expect(hits(outcome, 'src/Calculator.c', ADD_LINE) === 1, 'B7: the deferred report');

    settings.mixins = [`${WS}/mixins/native.yml`];
    only(await engine.discover());
    ({ outcome } = await step('B8 file, a native report', (r) => engine.runFile('project', calculator, r, token(), coverageMode('bullseye')), [ADD]));
    checks.expect(outcome?.kind === 'missing' && outcome.message.includes(':xml_report: to :cobertura'), 'B8: told to choose Cobertura');

    // project/other.yml builds apart, in build2, beside the same coverage file.
    settings.mixins = [cobertura];
    settings.projects = [{ path: 'project', debugLaunchConfig: 'dbg' }, { path: 'project/other.yml', debugLaunchConfig: 'dbg' }];
    const [base, other] = await engine.discover();
    const before = resets();
    const mode = coverageMode('bullseye');
    const first = recordingReporter(), second = recordingReporter();
    await engine.runFile(base.projectKey, fileOf(base, 'test/test_calculator.c'), first, token(), mode);
    await engine.runFile(other.projectKey, fileOf(other, 'test/test_clamp.c'), second, token(), mode);
    console.log(`B9 two projects in one directory: ${[...first.outcomes, ...second.outcomes].map(describeOutcome).join(' | ')}; ${resets() - before} reset(s)`);
    checks.expect(resets() - before === 1, 'B9: one reset for the shared coverage file');
    checks.expect(second.last()?.kind === 'report' && hits(second.last(), 'src/Calculator.c', ADD_LINE) === 1 && hits(second.last(), `${WS}/lib/Clamp.c`, CLAMP_LINE) === 1,
        "B9: the second project's report counts the first's run too");

    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
    engine.dispose();
    for (const line of logSummary(logs)) console.log(`  log ${line}`);
});
