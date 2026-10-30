// A project running another Ceedling installation than the image's own, selected each way Ceedling
// allows: `:project` ↳ `:which_ceedling` in the project file or in a mixin, WHICH_CEEDLING, or a copy
// in the project's vendor/ceedling. Every installation under /opt/ceedling runs each way. Ceedling
// alone first shows whether the image's launcher can run that installation at all.
// - Where it can't, Ceedling's own exception must reach the user, from discovery or a run.
// - Where it can, discovery must list the project's tests, a run must report what the image's own
//   Ceedling reports, and a debug build must return the executable Ceedling just built.
// - A rediscovery during a build must take the locks for an installation before 1.2.1, whose
//   discovery rewrites the build root. Whether it skips them otherwise is printed, not judged.
// Nothing may be left running.
//
// usage: node mixed.js
import * as child_process from 'child_process';
import * as fs from 'fs';
import { capabilitiesOf, ceedlingRelease } from '../../src/ceedlingProjectConfig';
import type { CeedlingProjectNode } from '../../src/testModel';
import {
    ceedlingVersion, leftovers, main, makeEngine, newestExecutable, only, parseArgs, recordingReporter, rediscoverDuringBuild, stage, token, WS,
} from './harness';

const INSTALLATIONS = '/opt/ceedling';
const WAYS = ['project file', 'mixin', 'WHICH_CEEDLING', 'vendor/ceedling'] as const;
type Way = typeof WAYS[number];
const MIXIN = `${WS}/mixins/which.yml`;

// Each test's result, in id order, so runs compare whatever order their results arrive in.
const tally = (results: ReadonlyMap<string, string>) => [...results].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => `${id}=${r}`).join(', ');

// A fresh copy of the latency workspace, its slow test holding a full build open for the gate check.
function fresh(): void {
    fs.rmSync(`${WS}/project`, { recursive: true, force: true });
    fs.rmSync(`${WS}/mixins`, { recursive: true, force: true });
    stage('tests/validation/workspaces/latency');
}

// A fresh workspace with `installation` selected `way`. Returns the mixins the project needs.
function prepare(installation: string, way: Way): string[] {
    fresh();
    const which = `${INSTALLATIONS}/${installation}`;
    if (way === 'project file') {
        const file = `${WS}/project/project.yml`;
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^:project:\n/m, `:project:\n  :which_ceedling: ${which}\n`));
    } else if (way === 'mixin') {
        fs.mkdirSync(`${WS}/mixins`, { recursive: true });
        fs.writeFileSync(MIXIN, `---\n:project:\n  :which_ceedling: ${which}\n`);
        return [MIXIN];
    } else if (way === 'vendor/ceedling') {
        fs.cpSync(which, `${WS}/project/vendor/ceedling`, { recursive: true });
    }
    return [];
}

// Whether the image's launcher runs the selected installation through a whole build, and its
// exception if not.
function ceedlingAlone(mixins: readonly string[]): { runs: boolean, exception: string | undefined } {
    const result = child_process.spawnSync('ceedling', ['test:all', ...mixins.flatMap((m) => ['--mixin', m])], { cwd: `${WS}/project`, encoding: 'utf8', timeout: 300000 });
    const exception = /EXCEPTION:\s*(.*)$/m.exec(`${result.stdout}\n${result.stderr}`)?.[1]?.trim();
    return { runs: result.status === 0, exception };
}

main('mixed', async (checks) => {
    parseArgs([]);
    const installations = fs.readdirSync(INSTALLATIONS).sort();
    console.log(`launcher Ceedling ${ceedlingVersion()}; installations ${installations.join(', ')}`);

    // What the image's own Ceedling reports, which every installation must match.
    fresh();
    let expected: string;
    {
        const { engine } = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg' }] });
        const project = only(await engine.discover());
        const reporter = recordingReporter();
        await engine.runProjectAll('project', project.files, reporter, token());
        expected = tally(reporter.results);
        engine.dispose();
    }

    for (const installation of installations) {
        const release = ceedlingRelease(installation) ?? installation;
        const readOnly = capabilitiesOf(release).readOnlyDiscovery;
        for (const way of WAYS) {
            const label = `${installation} via ${way}`;
            const mixins = prepare(installation, way);
            if (way === 'WHICH_CEEDLING') process.env.WHICH_CEEDLING = `${INSTALLATIONS}/${installation}`;
            try {
                const alone = ceedlingAlone(mixins);
                // Ceedling alone built the project, so the engine's own builds start from a clean one.
                fs.rmSync(`${WS}/project/build`, { recursive: true, force: true });
                const { engine, logs } = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg', mixins }] });
                if (!alone.runs) {
                    let failure: string;
                    try {
                        // eslint-disable-next-line no-await-in-loop -- one installation at a time
                        const project = only(await engine.discover());
                        const reporter = recordingReporter();
                        // eslint-disable-next-line no-await-in-loop -- as above
                        await engine.runProjectAll('project', project.files, reporter, token());
                        failure = [...reporter.results.values()].filter((r) => r.startsWith('errored')).join('\n');
                    } catch (error) {
                        failure = error instanceof Error ? error.message : String(error);
                    }
                    console.log(`${label}: Ceedling can't run it (${alone.exception ?? 'no exception'}); the engine reports: ${failure.split('\n')[0].slice(0, 160)}`);
                    checks.expect(failure !== '' && (alone.exception === undefined || failure.includes(alone.exception)),
                        `${label}: Ceedling stops with "${alone.exception}", but the engine reports "${failure.slice(0, 200)}"`);
                    engine.dispose();
                    continue;
                }

                let project: CeedlingProjectNode;
                try {
                    // eslint-disable-next-line no-await-in-loop -- one installation at a time
                    project = only(await engine.discover());
                } catch (error) {
                    checks.fail(`${label}: discovery failed though Ceedling runs it: ${error instanceof Error ? error.message : String(error)}`);
                    engine.dispose();
                    continue;
                }
                const reporter = recordingReporter();
                // eslint-disable-next-line no-await-in-loop -- as above
                const timing = await rediscoverDuringBuild(engine, logs, project, reporter);
                checks.expect(tally(reporter.results) === expected, `${label}: results ${tally(reporter.results)}, expected ${expected}`);
                checks.expect(timing.discovered.length === 1 && timing.discovered[0].files.length === project.files.length, `${label}: the rediscovery listed ${timing.discovered[0]?.files.length ?? 0} files, not ${project.files.length}`);
                const locked = timing.discoveryEnd > timing.buildEnd;
                if (!readOnly) checks.expect(locked, `${label}: discovery skipped the locks, though Ceedling ${release} rewrites the build root`);

                const file = project.files.find((f) => f.id === 'test/test_calculator.c')!;
                // eslint-disable-next-line no-await-in-loop -- as above
                const executable = await engine.compileForDebug('project', file, recordingReporter(), token());
                const built = newestExecutable(`${WS}/project/build`, 'test_calculator.out');
                checks.expect(executable === built, `${label}: debug returned ${executable}, but Ceedling built ${built ?? 'nothing'}`);
                const warned = logs.some((l) => l.level === 'warn' && l.message.includes('from another installation'));
                console.log(`${label}: runs; discovery ${locked ? 'took the locks' : 'skipped the locks'}${warned ? ', with a warning' : ''}; debug ${executable}`);
                engine.dispose();
            } finally {
                delete process.env.WHICH_CEEDLING;
            }
        }
    }
    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
});
