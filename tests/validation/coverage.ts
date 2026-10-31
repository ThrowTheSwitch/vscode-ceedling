// Coverage against real Ceedling, gcovr, and ReportGenerator. The first phase checks exact
// outcomes one run at a time:
// - gcovr's report is read when both utilities write one;
// - counters reset before each request by default, and accumulate when that's turned off;
// - gcovr leaves out a source above the project directory, outside its report root;
// - ReportGenerator's report is read when it is the only one, and covers that source at its own path.
// The second phase overlaps coverage runs with plain runs, discovery, reparses, and clean, some
// cancelled, and checks that every completed coverage run passes and yields a report.
//
// Images without ReportGenerator (Ceedling 1.0.0's) skip its checks.
//
// usage: node coverage.js [seconds=60] [maxInFlight=5] [seed=1]
import { coverageMode } from '../../src/coverageRun';
import { churn, describeOutcome, fileOf, hasCommand, hits, leftovers, logSummary, main, makeEngine, only, parseArgs, recordingReporter, seeded, stage, token, WS } from './harness';

main('coverage', async (checks) => {
    const { numbers: [seconds, maxInFlight, seed] } = parseArgs([60, 5, 1]);
    stage('tests/validation/workspaces/coverage');
    const reportGenerator = hasCommand('reportgenerator');
    const both = reportGenerator ? `${WS}/mixins/both.yml` : `${WS}/mixins/gcovr.yml`;
    const settings: Record<string, unknown> = { projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [both], coverageResetsCounters: true };
    const { engine, logs } = makeEngine(settings);
    const { random, pick } = seeded(seed);

    let project = only(await engine.discover());
    const calculator = fileOf(project, 'test/test_calculator.c'), clamp = fileOf(project, 'test/test_clamp.c');
    const step = async (label: string, run: (reporter: ReturnType<typeof recordingReporter>) => Promise<void>, passing: string[]) => {
        const reporter = recordingReporter();
        await run(reporter);
        console.log(`${label}: ${reporter.outcomes.map(describeOutcome).join(' | ')}`);
        for (const id of passing) checks.expect(reporter.results.get(id) === 'passed', `${label}: ${id} ${reporter.results.get(id)}`);
        return reporter.last();
    };
    const ADD = 'test/test_calculator.c::test_add', CLAMP = 'test/test_clamp.c::test_clamp_low';

    let outcome = await step('C1 file, gcovr preferred', (r) => engine.runFile('project', calculator, r, token(), coverageMode()), [ADD]);
    checks.expect(outcome?.kind === 'report' && outcome.path.endsWith('gcovr/GcovCoverageCobertura.xml'), 'C1: expected the gcovr report');
    checks.expect(hits(outcome, 'src/Calculator.c', 5) === 1 && hits(outcome, 'src/Calculator.c', 10) === 0, 'C1: Calculator.c hits');

    outcome = await step('C2 the same file again, counters reset', (r) => engine.runFile('project', calculator, r, token(), coverageMode()), [ADD]);
    checks.expect(hits(outcome, 'src/Calculator.c', 5) === 1, 'C2: a reset should leave 1 hit');

    settings.coverageResetsCounters = false;
    outcome = await step('C3 the same file again, counters kept', (r) => engine.runFile('project', calculator, r, token(), coverageMode()), [ADD]);
    checks.expect(hits(outcome, 'src/Calculator.c', 5) === 2, 'C3: kept counters should add up to 2 hits');
    settings.coverageResetsCounters = true;

    await step('C4 function', (r) => engine.runFunction('project', calculator, calculator.functions[0], r, token(), coverageMode()), [ADD]);

    outcome = await step('C5 file whose source is above the project', (r) => engine.runFile('project', clamp, r, token(), coverageMode()), [CLAMP]);
    checks.expect(outcome?.kind === 'report' && hits(outcome, 'lib/Clamp.c', 5) === undefined, 'C5: gcovr should leave out lib/Clamp.c');

    outcome = await step('C6 project', (r) => engine.runProjectAll('project', project.files, r, token(), coverageMode()), [ADD, CLAMP]);
    checks.expect(hits(outcome, 'src/Calculator.c', 5) === 1, 'C6: Calculator.c hits');

    if (reportGenerator) {
        settings.mixins = [`${WS}/mixins/reportgenerator.yml`];
        project = only(await engine.discover());
        outcome = await step('C7 project, ReportGenerator only', (r) => engine.runProjectAll('project', project.files, r, token(), coverageMode()), [ADD, CLAMP]);
        checks.expect(outcome?.kind === 'report' && outcome.path.endsWith('ReportGenerator/Cobertura.xml'), 'C7: expected the ReportGenerator report');
        checks.expect(hits(outcome, `${WS}/lib/Clamp.c`, 5) === 1 && hits(outcome, `${WS}/project/src/Calculator.c`, 5) === 1, 'C7: hits by absolute path');
        settings.mixins = [both];
    } else {
        console.log('C7 skipped: this image has no ReportGenerator');
    }

    project = only(await engine.discover());
    const counts: Record<string, number> = {};
    await churn(seconds, maxInFlight, async () => {
        const kind = pick(['coverFile', 'coverFile', 'coverFunction', 'coverProject', 'runFile', 'discover', 'reparse', 'clean']);
        counts[kind] = (counts[kind] ?? 0) + 1;
        const target = pick(project.files);
        const t = token();
        if (random() < 0.15) setTimeout(() => t.fire(), Math.floor(random() * 3000));
        const reporter = recordingReporter();
        try {
            if (kind === 'coverFile') await engine.runFile('project', target, reporter, t, coverageMode());
            else if (kind === 'coverFunction') await engine.runFunction('project', target, target.functions[0], reporter, t, coverageMode());
            else if (kind === 'coverProject') await engine.runProjectAll('project', project.files, reporter, t, coverageMode());
            else if (kind === 'runFile') await engine.runFile('project', target, reporter, t);
            else if (kind === 'discover') { project = only(await engine.discover()); return; }
            else if (kind === 'reparse') { await engine.rediscoverFile('project', target.id); return; }
            else { await engine.clean(t); return; }
            if (t.isCancellationRequested) return;
            for (const [id, result] of reporter.results) checks.expect(result === 'passed', `${kind} ${target.id}: ${id} ${result}`);
            if (kind.startsWith('cover')) {
                checks.expect(reporter.outcomes.length > 0, `${kind} ${target.id}: no coverage outcome`);
                // After a clean, a run of only test_clamp.c covers only lib/Clamp.c, which gcovr leaves out,
                // so its report has no files.
                for (const o of reporter.outcomes) checks.expect(o.kind === 'report' || o.message.includes('covers no source files'), `${kind} ${target.id}: ${describeOutcome(o)}`);
            }
        } catch (error) {
            checks.fail(`${kind} threw: ${error instanceof Error ? error.stack : String(error)}`);
        }
    });

    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
    engine.dispose();
    console.log(`overlap: ${seconds} s, ${maxInFlight} at once, seed ${seed}; operations ${JSON.stringify(counts)}`);
    for (const line of logSummary(logs)) console.log(`  log ${line}`);
});
