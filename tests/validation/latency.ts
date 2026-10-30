// A rediscovery during a full build of the same project, which the project's slow test keeps
// running about 4 seconds. From Ceedling 1.2.1 discovery takes no locks, so its dumpconfig must
// start before the build ends. Before 1.2.1 it waits for the build's locks, so it must end after
// the build. Each build's results must be unchanged either way. See docs/Architecture.md,
// "Discovery without the locks from 1.2.1".
//
// --vendored copies the image's own Ceedling into the project's vendor/ceedling, which `ceedling
// version` must then report as another installation. A copy of the same build must gate the same
// way, and warns only where its release is unknown, as with 1.0.0's commitless version.
//
// usage: node latency.js [--vendored]
import * as child_process from 'child_process';
import * as fs from 'fs';
import { parseCeedlingVersions } from '../../src/ceedlingOutputParsing';
import { applicationRelease } from '../../src/ceedlingProjectConfig';
import { capabilities, ceedlingVersion, main, makeEngine, only, parseArgs, recordingReporter, stage, token, WS } from './harness';

// Each test's result, in id order, so runs compare whatever order their results arrive in.
const tally = (results: ReadonlyMap<string, string>) => [...results].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => `${id}=${r}`).join(', ');

main('latency', async (checks) => {
    const vendored = parseArgs([], ['--vendored']).flags.has('--vendored');
    const lockFree = capabilities().readOnlyDiscovery;
    console.log(`Ceedling ${ceedlingVersion()}${vendored ? ', vendored' : ''}: discovery ${lockFree ? 'runs alongside builds' : 'waits for builds'}`);
    stage('tests/validation/workspaces/latency');
    if (vendored) {
        const gem = child_process.execFileSync('ruby', ['-e', 'print Gem::Specification.find_by_name("ceedling").gem_dir'], { encoding: 'utf8' });
        fs.cpSync(gem, `${WS}/project/vendor/ceedling`, { recursive: true });
    }
    const { engine, logs } = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg' }] });
    const project = only(await engine.discover());
    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    for (const warning of warnings) console.log(`warning: ${warning}`);
    if (vendored) {
        const reported = parseCeedlingVersions(child_process.execFileSync('ceedling', ['version'], { cwd: `${WS}/project`, encoding: 'utf8' }));
        checks.expect(reported?.launcher !== undefined, `ceedling version reports no launcher for the vendored copy: ${JSON.stringify(reported)}`);
        const exact = reported !== undefined && applicationRelease(reported)?.exactRelease === true;
        const warned = warnings.some((w) => w.includes('from another installation'));
        checks.expect(warned === !exact, `the vendored copy's release is ${exact ? 'known' : 'unknown'}, but the engine ${warned ? 'warned' : "didn't warn"}`);
    }

    const baseline = recordingReporter();
    let start = Date.now();
    await engine.runProjectAll('project', project.files, baseline, token());
    const buildMs = Date.now() - start;
    start = Date.now();
    await engine.discover();
    console.log(`idle discovery ${Date.now() - start} ms; full build ${buildMs} ms`);

    for (let i = 1; i <= 3; i++) {
        const reporter = recordingReporter();
        const run = engine.runProjectAll('project', project.files, reporter, token()).then(() => Date.now());
        // eslint-disable-next-line no-await-in-loop -- each sample starts its own build, then rediscovers during it
        await new Promise((resolve) => setTimeout(resolve, 300));
        const discoveryStart = Date.now();
        const mark = logs.length;
        // eslint-disable-next-line no-await-in-loop -- as above
        await engine.discover();
        const discoveryEnd = Date.now();
        // eslint-disable-next-line no-await-in-loop -- as above
        const buildEnd = await run;
        // When discovery's dumpconfig started, which a lock would hold back until the build ends.
        const dumpconfigAt = logs.slice(mark).find((l) => /^ceedling: \S+ dumpconfig/.test(l.message))?.at ?? Infinity;
        const gap = buildEnd - discoveryEnd;
        console.log(`  discovery during a build: ${discoveryEnd - discoveryStart} ms, ending ${Math.abs(gap)} ms ${gap >= 0 ? 'before' : 'after'} the build`);
        if (lockFree) checks.expect(dumpconfigAt < buildEnd, `sample ${i}: discovery's dumpconfig started after the build ended`);
        else checks.expect(discoveryEnd > buildEnd, `sample ${i}: discovery ended before the build did`);
        checks.expect(tally(reporter.results) === tally(baseline.results), `sample ${i}: results ${tally(reporter.results)}, expected ${tally(baseline.results)}`);
    }
    engine.dispose();
});
