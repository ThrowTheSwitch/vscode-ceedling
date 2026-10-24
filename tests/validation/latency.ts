// How long a rediscovery takes while a full build of the same project runs. The project's slow test
// keeps each build running about 4 seconds. Discovery waits for the build's locks, so it takes about
// as long as what's left of the build. A measurement for
// docs/Architecture.md's "Possible speedup"; it checks only that each build's results are unchanged.
//
// usage: node latency.js
import { main, makeEngine, only, recordingReporter, stage, token } from './harness';

// Each test's result, in id order, so runs compare whatever order their results arrive in.
const tally = (results: ReadonlyMap<string, string>) => [...results].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => `${id}=${r}`).join(', ');

main('latency', async (checks) => {
    stage('tests/validation/workspaces/latency');
    const { engine } = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg' }] });
    const project = only(await engine.discover());

    const baseline = recordingReporter();
    let start = Date.now();
    await engine.runProjectAll('project', project.files, baseline, token());
    const buildMs = Date.now() - start;
    start = Date.now();
    await engine.discover();
    console.log(`idle discovery ${Date.now() - start} ms; full build ${buildMs} ms`);

    for (let i = 0; i < 3; i++) {
        const reporter = recordingReporter();
        const buildStart = Date.now();
        const run = engine.runProjectAll('project', project.files, reporter, token()).then(() => Date.now() - buildStart);
        // eslint-disable-next-line no-await-in-loop -- each sample starts its own build, then rediscovers during it
        await new Promise((resolve) => setTimeout(resolve, 300));
        const discoveryStart = Date.now();
        // eslint-disable-next-line no-await-in-loop -- as above
        await engine.discover();
        const discoveryMs = Date.now() - discoveryStart;
        // eslint-disable-next-line no-await-in-loop -- as above
        const runMs = await run;
        console.log(`  discovery during a build: ${discoveryMs} ms (build ${runMs} ms)`);
        checks.expect(tally(reporter.results) === tally(baseline.results), `sample ${i + 1}: results ${tally(reporter.results)}, expected ${tally(baseline.results)}`);
    }
    engine.dispose();
});
