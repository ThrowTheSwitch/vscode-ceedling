// Test build directories in a project with two test roots, +:test/** and +:extra/**, each holding
// a test_calc.c. From 1.2.0 each test builds in a directory of its own, and the engine must find
// each one exactly, whatever the version names it:
// - a debug build returns the executable Ceedling just built, the newest of its name;
// - from 1.2.1, a coverage request whose --test-case filter also matches another test in the file
//   reruns the whole file, clearing only that file's counters. Its hits must equal those of a
//   request that ran the whole file at once, so the other test_calc.c keeps its own, and the file's
//   aren't counted twice. Ceedling 1.2.0's gcov: tasks take only the bare filename, which it can't
//   resolve here.
// Ceedling before 1.2.0 builds both files in one directory, so the suite skips.
//
// usage: node layout.js
import { coverageMode } from '../../src/ceedlingEngine';
import { capabilities, ceedlingVersion, describeOutcome, fileOf, main, makeEngine, newestExecutable, only, parseArgs, recordingReporter, requires, stage, token, WS } from './harness';

main('layout', async (checks) => {
    parseArgs([]);
    if (!requires('nestedTestBuilds', "can't build same-named test files")) return;
    stage('tests/validation/workspaces/layout');
    const { engine, logs } = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [`${WS}/mixins/gcovr.yml`] });
    const project = only(await engine.discover());
    const file = (id: string) => fileOf(project, id);

    for (const id of ['test/unit/test_calc.c', 'extra/integration/test_calc.c']) {
        // eslint-disable-next-line no-await-in-loop -- one build at a time, so each executable is this build's own
        const executable = await engine.compileForDebug('project', file(id), recordingReporter(), token());
        const built = newestExecutable(`${WS}/project/build`, 'test_calc.out');
        console.log(`debug ${id}: ${executable}; built ${built ?? 'nothing'}`);
        checks.expect(executable === built, `debug ${id}: the engine returned ${executable}, but Ceedling built ${built ?? 'nothing'}`);
    }

    if (!capabilities().pathQualifiedCoverageTasks) {
        console.log(`coverage skipped: Ceedling ${ceedlingVersion()}'s gcov: tasks can't name either test_calc.c`);
        engine.dispose();
        return;
    }
    const pairs = [['extra/integration/test_calc.c', 'test/unit/test_calc.c', 'test_add'], ['test/unit/test_calc.c', 'extra/integration/test_calc.c', 'test_clamp']] as const;
    for (const [first, second, name] of pairs) {
        const target = file(second);
        // The reference: one request covering the first file, then the whole second file.
        const reference = recordingReporter();
        const referenceMode = coverageMode();
        // eslint-disable-next-line no-await-in-loop -- each request's runs go in order
        await engine.runFile('project', file(first), reference, token(), referenceMode);
        // eslint-disable-next-line no-await-in-loop -- as above
        await engine.runFile('project', target, reference, token(), referenceMode);

        const reporter = recordingReporter();
        const mode = coverageMode();
        // eslint-disable-next-line no-await-in-loop -- as above
        await engine.runFile('project', file(first), reporter, token(), mode);
        const mark = logs.length;
        // eslint-disable-next-line no-await-in-loop -- as above
        await engine.runFunction('project', target, target.functions.find((f) => f.id === `${second}::${name}`)!, reporter, token(), mode);
        const fellBack = logs.slice(mark).some((l) => l.level === 'warn' && l.message.includes('also matched an unrelated test'));
        checks.expect(fellBack, `cover ${second} --test-case=${name}: expected the filter to collide and the whole file to rerun`);
        const [got, want] = [reporter.last(), reference.last()].map((outcome) => outcome ? describeOutcome(outcome) : 'no coverage');
        console.log(`cover ${first}, then ${second} --test-case=${name}: ${got}`);
        checks.expect(got === want, `cover ${first}, then ${second} --test-case=${name}: hits ${got}, expected those of the whole file, ${want}`);
        const failures = [...reporter.results].filter(([, result]) => result !== 'passed');
        checks.expect(failures.length === 0, `cover ${first}, then ${second}: ${failures.map(([id, result]) => `${id} ${result}`).join(', ')}`);
    }
    engine.dispose();
});
