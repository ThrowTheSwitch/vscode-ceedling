// A project running another Ceedling installation than the image's own, selected each way Ceedling
// allows: `:project` ↳ `:which_ceedling` in the project file or in a mixin, WHICH_CEEDLING, or a copy
// in the project's vendor/ceedling. Every installation under /opt/ceedling runs each way. Ceedling
// alone first shows whether the image's launcher can run that installation at all, and that the
// selection took effect.
// - Where Ceedling can't run it, Ceedling's own exception must reach the user.
// - Where it can, a run must report what the image's own Ceedling reports, and a rediscovery during
//   it must list every test file. A debug build of a nested test, whose build directory differs
//   between layouts, must return the executable Ceedling just built.
// - Before 1.2.1, that rediscovery must take the locks, since the installation's discovery rewrites
//   the build root. Whether it skips them from 1.2.1 is printed, not judged.
// Nothing may be left running.
//
// usage: node mixed.js
import * as fs from 'fs';
import type { CeedlingEngine } from '../../src/ceedlingEngine';
import { capabilitiesOf, ceedlingRelease } from '../../src/ceedlingVersions';
import {
    builtExecutable, ceedlingAlone, ceedlingVersion, fileOf, INSTALLATIONS, leftovers, main, makeEngine, only, parseArgs, recordingReporter,
    rediscoverDuringBuild, removeExecutables, stage, tally, token, WS,
} from './harness';

const WAYS = ['project file', 'mixin', 'WHICH_CEEDLING', 'vendor/ceedling'] as const;
type Way = typeof WAYS[number];
const MIXIN = `${WS}/mixins/which.yml`;
// Flat before 1.2.0, below its test root from 1.2.0, and below the project root from 1.2.2.
const NESTED = 'test/unit/test_nested.c';

// A fresh copy of the latency workspace, whose slow test holds a full build open for the lock
// check, plus the nested test.
function fresh(): void {
    fs.rmSync(`${WS}/project`, { recursive: true, force: true });
    fs.rmSync(`${WS}/mixins`, { recursive: true, force: true });
    stage('tests/validation/workspaces/latency');
    fs.mkdirSync(`${WS}/project/test/unit`, { recursive: true });
    fs.writeFileSync(`${WS}/project/${NESTED}`, '#include "unity.h"\n\nvoid test_nested(void)\n{\n}\n');
}

// A fresh workspace with `installation` selected `way`. Returns the mixins the project needs.
function prepare(installation: string, way: Way): string[] {
    fresh();
    const which = `${INSTALLATIONS}/${installation}`;
    if (way === 'project file') {
        const file = `${WS}/project/project.yml`;
        const original = fs.readFileSync(file, 'utf8');
        const selecting = original.replace(/^:project:\n/m, `:project:\n  :which_ceedling: ${which}\n`);
        if (selecting === original) throw new Error(`${file} has no :project: section to select ${which} in`);
        fs.writeFileSync(file, selecting);
    } else if (way === 'mixin') {
        fs.mkdirSync(`${WS}/mixins`, { recursive: true });
        fs.writeFileSync(MIXIN, `---\n:project:\n  :which_ceedling: ${which}\n`);
        return [MIXIN];
    } else if (way === 'WHICH_CEEDLING') {
        process.env.WHICH_CEEDLING = which;
    } else {
        fs.cpSync(which, `${WS}/project/vendor/ceedling`, { recursive: true });
    }
    return [];
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
        checks.expect(reporter.results.size > 0 && [...reporter.results.values()].every((r) => r === 'passed'), `the image's own Ceedling reports ${expected || 'nothing'}`);
        engine.dispose();
    }

    for (const installation of installations) {
        const release = ceedlingRelease(installation) ?? installation;
        const readOnly = capabilitiesOf(release).readOnlyDiscovery;
        for (const way of WAYS) {
            const label = `${installation} via ${way}`;
            let engine: CeedlingEngine | undefined;
            try {
                const mixins = prepare(installation, way);
                // Ceedling names the installation it launches at obnoxious verbosity.
                const alone = ceedlingAlone(['test:all', '--verbosity=obnoxious', ...mixins.flatMap((m) => ['--mixin', m])], `${WS}/project`);
                const marker = way === 'vendor/ceedling' ? 'vendor/ceedling/' : `${INSTALLATIONS}/${installation}/`;
                checks.expect(!alone.runs || alone.output.includes(marker), `${label}: Ceedling ran without naming ${marker}, so the selection may not have taken effect`);
                // The engine's own builds start from a clean build root.
                fs.rmSync(`${WS}/project/build`, { recursive: true, force: true });
                const made = makeEngine({ projects: [{ path: 'project', debugLaunchConfig: 'dbg', mixins }] });
                engine = made.engine;

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
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop -- one installation at a time
                const project = only(await engine.discover());
                const reporter = recordingReporter();
                // eslint-disable-next-line no-await-in-loop -- as above
                const timing = await rediscoverDuringBuild(engine, made.logs, project, reporter);
                checks.expect(tally(reporter.results) === expected, `${label}: results ${tally(reporter.results)}, expected ${expected}`);
                const listed = timing.discovered[0]?.files.length ?? 0;
                checks.expect(timing.discovered.length === 1 && listed === project.files.length, `${label}: the rediscovery listed ${listed} files, not ${project.files.length}`);
                if (!readOnly) checks.expect(timing.heldBack, `${label}: discovery skipped the locks, though Ceedling ${release} rewrites the build root`);

                removeExecutables(`${WS}/project/build`, 'test_nested.out');
                // eslint-disable-next-line no-await-in-loop -- as above
                const executable = await engine.compileForDebug('project', fileOf(project, NESTED), recordingReporter(), token());
                const built = builtExecutable(`${WS}/project/build`, 'test_nested.out');
                checks.expect(executable === built, `${label}: debug returned ${executable}, but Ceedling built ${built ?? 'nothing'}`);
                const warned = made.logs.some((l) => l.level === 'warn' && l.message.includes('from another installation'));
                console.log(`${label}: runs; discovery ${timing.heldBack ? 'took the locks' : 'skipped the locks'}${warned ? ', with a warning' : ''}; debug ${executable}`);
            } catch (error) {
                checks.fail(`${label} threw: ${error instanceof Error ? error.stack : String(error)}`);
            } finally {
                delete process.env.WHICH_CEEDLING;
                engine?.dispose();
            }
        }
    }
    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
});
