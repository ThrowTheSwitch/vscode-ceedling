// What the engine does differently per Ceedling version, on a project holding same-named test
// files, test/unit/test_dup.c and test/integration/test_dup.c. Each step records the Ceedling
// command lines the engine issued and the warnings it logged, then checks them with the results
// and coverage hits:
// - From 1.2.1, coverage tasks name the test file by path, and results and hits are exact.
// - On 1.2.0, coverage tasks can name only the bare filename, so the engine warns that Ceedling
//   can't tell the two files apart, and Ceedling stops with an ambiguous file reference error.
//   Only the commands and the warning are checked.
// Plain runs name the file by path on both, and a debug build returns what Ceedling built.
// Ceedling before 1.2.0 can't build same-named test files at all, so the suite skips.
//
// usage: node gated.js
import { coverageMode } from '../../src/coverageRun';
import type { CoverageOutcome } from '../../src/testModel';
import { builtExecutable, capabilities, ceedlingVersion, describeOutcome, fileOf, hits, main, makeEngine, only, parseArgs, recordingReporter, removeExecutables, requires, stage, token, WS } from './harness';

const UNIT = 'test/unit/test_dup.c', INTEGRATION = 'test/integration/test_dup.c', FILTERS = 'test/test_filters.c';
const ADD = `${UNIT}::test_unit_add`, LOW = `${INTEGRATION}::test_integration_clamp_low`, HIGH = `${INTEGRATION}::test_integration_clamp_high`;
const ALPHA = `${FILTERS}::test_filter_alpha`, BETA = `${FILTERS}::test_filter_beta`;

main('gated', async (checks) => {
    parseArgs([]);
    if (!requires('nestedTestBuilds', "can't build same-named test files")) return;
    const pathTasks = capabilities().pathQualifiedCoverageTasks;
    console.log(`Ceedling ${ceedlingVersion()}: coverage tasks name ${pathTasks ? 'paths' : 'bare filenames'}`);
    stage('tests/validation/workspaces/gated');
    const settings: Record<string, unknown> = { projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [`${WS}/mixins/gcovr.yml`], coverageResetsCounters: true };
    const { engine, logs } = makeEngine(settings);

    let project = only(await engine.discover());
    // Ceedling commands and warnings logged since the last call, without discovery's own commands.
    let mark = logs.length;
    const since = () => {
        const recent = logs.slice(mark);
        mark = logs.length;
        const commands = recent.filter((l) => l.level === 'debug' && l.message.startsWith('ceedling: '))
            .map((l) => l.message.replace(/^ceedling: ceedling /, '').replace(/ \(cwd=.*$/, '').replace(/ --project .*$/, ''))
            .filter((c) => !/^(version|dumpconfig|files:test)/.test(c));
        const warnings = recent.filter((l) => l.level === 'warn' || l.level === 'showWarning').map((l) => l.message);
        return { commands, warnings };
    };
    const rediscover = async (mixin: string) => {
        settings.mixins = [`${WS}/mixins/${mixin}`];
        project = only(await engine.discover());
        since();
    };
    const file = (id: string) => fileOf(project, id);
    const fn = (fileId: string, id: string) => file(fileId).functions.find((f) => f.id === id)!;

    type Step = { results: Map<string, string>, commands: string[], warnings: string[], outcome: CoverageOutcome | undefined };
    const step = async (label: string, work: (reporter: ReturnType<typeof recordingReporter>) => Promise<unknown>, check: (s: Step) => void) => {
        const reporter = recordingReporter();
        await work(reporter);
        const { commands, warnings } = since();
        console.log(`${label}\n    commands: ${commands.join(' ; ')}\n    results:  ${[...reporter.results].map(([id, r]) => `${id.split('::')[1]}=${r}`).join(', ')}` +
            (reporter.outcomes.length ? `\n    coverage: ${reporter.outcomes.map(describeOutcome).join(' | ')}` : '') +
            (warnings.length ? `\n    warnings: ${warnings.map((w) => w.slice(0, 200)).join(' | ')}` : ''));
        check({ results: reporter.results, commands, warnings, outcome: reporter.last() });
    };
    const results = (label: string, got: Map<string, string>, want: Record<string, string>) => {
        for (const [id, result] of Object.entries(want)) checks.expect(got.get(id) === result, `${label}: ${id} expected ${result}, got ${got.get(id)}`);
        for (const id of got.keys()) checks.expect(id in want, `${label}: unexpected result for ${id}`);
    };
    const oneCommand = (label: string, commands: string[], expected: string) => {
        checks.expect(commands.length === 1, `${label}: expected one build, got ${commands.length}`);
        checks.expect(commands[0]?.startsWith(expected) === true, `${label}: expected '${expected}…', got '${commands[0]}'`);
    };
    const coverTask = (id: string, extra = '') => `gcov:${pathTasks ? id : id.split('/').pop()}${extra} --force-test-rerun`;
    const ambiguity = (label: string, warnings: string[]) => {
        const warned = warnings.some((w) => w.includes("can't tell apart"));
        checks.expect(warned !== pathTasks, `${label}: ambiguity warning ${pathTasks ? 'logged' : 'missing'}`);
    };

    await step(`G1 cover ${UNIT}`, (r) => engine.runFile('project', file(UNIT), r, token(), coverageMode()), (s) => {
        oneCommand('G1', s.commands, coverTask(UNIT));
        ambiguity('G1', s.warnings);
        if (!pathTasks) return;
        results('G1', s.results, { [ADD]: 'passed' });
        checks.expect(hits(s.outcome, 'src/Calculator.c', 5) === 1 && !hits(s.outcome, 'src/Clamp.c', 6), 'G1: hits');
    });
    await step(`G2 cover ${INTEGRATION}`, (r) => engine.runFile('project', file(INTEGRATION), r, token(), coverageMode()), (s) => {
        oneCommand('G2', s.commands, coverTask(INTEGRATION));
        ambiguity('G2', s.warnings);
        if (!pathTasks) return;
        results('G2', s.results, { [LOW]: 'passed', [HIGH]: 'passed' });
        checks.expect(hits(s.outcome, 'src/Clamp.c', 6) === 1 && hits(s.outcome, 'src/Clamp.c', 8) === 1, 'G2: Clamp.c hits');
        checks.expect(!hits(s.outcome, 'src/Calculator.c', 5), 'G2: counters were reset, so Calculator.c should be unexecuted');
    });
    await step('G3 cover test_integration_clamp_high', (r) => engine.runFunction('project', file(INTEGRATION), fn(INTEGRATION, HIGH), r, token(), coverageMode()), (s) => {
        oneCommand('G3', s.commands, coverTask(INTEGRATION, ' --test-case=test_integration_clamp_high'));
        if (!pathTasks) return;
        results('G3', s.results, { [HIGH]: 'passed' });
        checks.expect(hits(s.outcome, 'src/Clamp.c', 8) === 1 && !hits(s.outcome, 'src/Clamp.c', 6), 'G3: only the high branch should be hit');
    });
    // Ceedling before 1.2.1 ignores a changed --test-case filter in a delta build (#1360).
    await step('G4 cover test_integration_clamp_low, a changed filter', (r) => engine.runFunction('project', file(INTEGRATION), fn(INTEGRATION, LOW), r, token(), coverageMode()), (s) => {
        oneCommand('G4', s.commands, coverTask(INTEGRATION, ' --test-case=test_integration_clamp_low'));
        if (!pathTasks) return;
        results('G4', s.results, { [LOW]: 'passed' });
        checks.expect(hits(s.outcome, 'src/Clamp.c', 6) === 1 && !hits(s.outcome, 'src/Clamp.c', 8), 'G4: only the low branch should be hit');
    });
    await step('G5 cover the project', (r) => engine.runProjectAll('project', project.files, r, token(), coverageMode()), (s) => {
        oneCommand('G5', s.commands, 'gcov:all --force-test-rerun');
        results('G5', s.results, { [ADD]: 'passed', [LOW]: 'passed', [HIGH]: 'passed', [ALPHA]: 'passed', [BETA]: 'failed' });
        checks.expect(hits(s.outcome, 'src/Calculator.c', 5) === 1 && hits(s.outcome, 'src/Clamp.c', 6) === 1 && hits(s.outcome, 'src/Clamp.c', 8) === 1, 'G5: hits');
    });

    await rediscover('task.yml');
    await step(`G6 cover ${UNIT} with :report_task: TRUE`, (r) => engine.runFile('project', file(UNIT), r, token(), coverageMode()), (s) => {
        oneCommand('G6', s.commands, coverTask(UNIT, ' report:gcov'));
        if (!pathTasks) return;
        results('G6', s.results, { [ADD]: 'passed' });
        checks.expect(hits(s.outcome, 'src/Calculator.c', 5) === 1, 'G6: Calculator.c hits');
    });

    await rediscover('reportgenerator.yml');
    await step(`G7 cover ${INTEGRATION} with ReportGenerator`, (r) => engine.runFile('project', file(INTEGRATION), r, token(), coverageMode()), (s) => {
        oneCommand('G7', s.commands, coverTask(INTEGRATION));
        if (!pathTasks) return;
        checks.expect(s.outcome?.kind === 'report' && s.outcome.path.endsWith('ReportGenerator/Cobertura.xml'), 'G7: expected the ReportGenerator report');
        results('G7', s.results, { [LOW]: 'passed', [HIGH]: 'passed' });
        checks.expect(hits(s.outcome, 'src/Clamp.c', 6) === 1 && hits(s.outcome, 'src/Clamp.c', 8) === 1, 'G7: Clamp.c hits');
    });

    await rediscover('gcovr.yml');
    await step(`G8 run ${UNIT}`, (r) => engine.runFile('project', file(UNIT), r, token()), (s) => {
        oneCommand('G8', s.commands, `test:${UNIT} --force-test-rerun`);
        results('G8', s.results, { [ADD]: 'passed' });
    });
    for (const [label, id, want] of [['G9a', ALPHA, 'passed'], ['G9b', BETA, 'failed'], ['G9c', ALPHA, 'passed']] as const) {
        const name = id.split('::')[1];
        // eslint-disable-next-line no-await-in-loop -- each run's filter must follow the one before
        await step(`${label} run ${name}`, (r) => engine.runFunction('project', file(FILTERS), fn(FILTERS, id), r, token()), (s) => {
            oneCommand(label, s.commands, `test:${FILTERS} --test-case=${name} --force-test-rerun`);
            results(label, s.results, { [id]: want });
        });
    }
    await step(`G10 debug build ${INTEGRATION}`, async (r) => {
        removeExecutables(`${WS}/project/build`, 'test_dup.out');
        const executable = await engine.compileForDebug('project', file(INTEGRATION), r, token());
        const built = builtExecutable(`${WS}/project/build`, 'test_dup.out');
        console.log(`    executable: ${executable}`);
        checks.expect(executable === built, `G10: executable ${executable}, but Ceedling built ${built ?? 'nothing'}`);
    }, (s) => results('G10', s.results, { [LOW]: 'passed', [HIGH]: 'passed' }));

    engine.dispose();
});
