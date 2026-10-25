// Test build directories in a project with two test roots, +:test/** and +:extra/**, each holding
// a test_calc.c. From 1.2.0, Ceedling names each test's build directory by its path below its own
// root, here unit/test_calc and integration/test_calc, and the engine must find each one exactly:
// - a debug build returns the executable it just built;
// - from 1.2.1, a coverage request whose --test-case filter also matches another test in the file
//   reruns the whole file, clearing only that file's counters, so the other test_calc.c keeps its
//   hits. Ceedling 1.2.0's gcov: tasks take only the bare filename, which it can't resolve here.
// Ceedling before 1.2.0 builds both files in one directory, so the suite skips.
//
// usage: node layout.js
import * as fs from 'fs';
import { coverageMode } from '../../src/ceedlingEngine';
import { capabilities, ceedlingVersion, fileOf, main, makeEngine, only, recordingReporter, requires, stage, token, WS } from './harness';

const BUILD_NAMES: Record<string, string> = { 'test/unit/test_calc.c': 'unit/test_calc', 'extra/integration/test_calc.c': 'integration/test_calc' };

main('layout', async (checks) => {
    if (!requires('nestedTestBuilds', "can't build same-named test files")) return;
    stage('tests/validation/workspaces/layout');
    const { engine, logs } = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [`${WS}/mixins/gcovr.yml`] });
    const project = only(await engine.discover());
    const file = (id: string) => fileOf(project, id);

    for (const [id, buildName] of Object.entries(BUILD_NAMES)) {
        const started = Date.now() - 1000;
        // eslint-disable-next-line no-await-in-loop -- one build at a time, so each executable is this build's own
        const executable = await engine.compileForDebug('project', file(id), recordingReporter(), token());
        const built = `${WS}/project/build/test/out/${executable}`;
        const fresh = fs.existsSync(built) && fs.statSync(built).mtimeMs >= started;
        console.log(`debug ${id}: ${executable} ${fresh ? '(just built)' : '(missing or stale)'}`);
        checks.expect(executable === `${buildName}/test_calc.out` && fresh, `debug ${id}: expected a fresh ${buildName}/test_calc.out, got ${executable}`);
    }

    if (!capabilities().pathQualifiedCoverageTasks) {
        console.log(`coverage skipped: Ceedling ${ceedlingVersion()}'s gcov: tasks can't name either test_calc.c`);
        engine.dispose();
        return;
    }
    const pairs = [['extra/integration/test_calc.c', 'test/unit/test_calc.c', 'test_add'], ['test/unit/test_calc.c', 'extra/integration/test_calc.c', 'test_clamp']] as const;
    for (const [first, second, name] of pairs) {
        const mode = coverageMode();
        const reporter = recordingReporter();
        // eslint-disable-next-line no-await-in-loop -- the two runs share one coverage request, in order
        await engine.runFile('project', file(first), reporter, token(), mode);
        const target = file(second);
        const mark = logs.length;
        // eslint-disable-next-line no-await-in-loop -- as above
        await engine.runFunction('project', target, target.functions.find((f) => f.id === `${second}::${name}`)!, reporter, token(), mode);
        const fellBack = logs.slice(mark).some((l) => l.level === 'warn' && l.message.includes('also matched an unrelated test'));
        checks.expect(fellBack, `cover ${second} --test-case=${name}: expected the filter to collide and the whole file to rerun`);
        const last = reporter.last();
        const linesHit = (source: string) => last?.kind === 'report' ? last.files.find((f) => f.path.endsWith(source))?.lines.filter((l) => l.hits > 0).length ?? 0 : 0;
        const failures = [...reporter.results].filter(([, result]) => result !== 'passed');
        console.log(`cover ${first}, then ${second} --test-case=${name}: Calculator.c lines hit ${linesHit('Calculator.c')}, Clamp.c lines hit ${linesHit('Clamp.c')}`);
        checks.expect(linesHit('Calculator.c') > 0 && linesHit('Clamp.c') > 0, `cover ${first}, then ${second}: the other test_calc.c lost its counters`);
        checks.expect(failures.length === 0, `cover ${first}, then ${second}: ${failures.map(([id, result]) => `${id} ${result}`).join(', ')}`);
    }
    engine.dispose();
});
