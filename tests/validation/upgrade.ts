// A project built by an older Ceedling, then by the image's own, as after an upgrade. Ceedling 1.2.2
// moves each test's build output, and the older layout's files stay until a clobber. For each
// older installation under /opt/ceedling the image's launcher can run, through WHICH_CEEDLING:
// 1. The older Ceedling runs, debug-builds, and covers the project.
// 2. With the image's own Ceedling, a debug build must return the executable just built, never the
//    one left in the older layout.
// 3. Coverage must equal coverage of a clobbered build. Reports read every counter on disk, so the
//    engine's counter reset must clear the older layout's too.
//
// usage: node upgrade.js
import * as child_process from 'child_process';
import * as fs from 'fs';
import semver from 'semver';
import { coverageMode } from '../../src/ceedlingEngine';
import { ceedlingRelease } from '../../src/ceedlingProjectConfig';
import { ceedlingVersion, describeOutcome, leftovers, main, makeEngine, newestExecutable, only, parseArgs, recordingReporter, stage, token, WS } from './harness';

const INSTALLATIONS = '/opt/ceedling';
const FILE = 'test/test_calculator.c';

main('upgrade', async (checks) => {
    parseArgs([]);
    const own = ceedlingVersion();
    const older = fs.readdirSync(INSTALLATIONS).filter((name) => semver.lt(ceedlingRelease(name) ?? name, own)).sort(semver.compare);
    console.log(`Ceedling ${own}; upgrading from ${older.join(', ') || 'nothing older'}`);
    const settings = { projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [`${WS}/mixins/gcovr.yml`] };

    for (const installation of older) {
        fs.rmSync(`${WS}/project`, { recursive: true, force: true });
        stage('tests/validation/workspaces/coverage');
        const { engine } = makeEngine(settings);
        const cover = async () => {
            const reporter = recordingReporter();
            await engine.runFile('project', only(await engine.discover()).files.find((f) => f.id === FILE)!, reporter, token(), coverageMode());
            const last = reporter.last();
            return last ? describeOutcome(last) : 'no coverage';
        };
        try {
            process.env.WHICH_CEEDLING = `${INSTALLATIONS}/${installation}`;
            const alone = child_process.spawnSync('ceedling', ['test:all', '--mixin', `${WS}/mixins/gcovr.yml`], { cwd: `${WS}/project`, encoding: 'utf8', timeout: 300000 });
            if (alone.status !== 0) {
                console.log(`from ${installation}: skipped, since the launcher can't run it`);
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- one installation at a time
            const before = only(await engine.discover());
            // eslint-disable-next-line no-await-in-loop -- as above
            await engine.compileForDebug('project', before.files.find((f) => f.id === FILE)!, recordingReporter(), token());
            // eslint-disable-next-line no-await-in-loop -- as above
            await cover();
            delete process.env.WHICH_CEEDLING;

            // eslint-disable-next-line no-await-in-loop -- as above
            const after = only(await engine.discover());
            // eslint-disable-next-line no-await-in-loop -- as above
            const executable = await engine.compileForDebug('project', after.files.find((f) => f.id === FILE)!, recordingReporter(), token());
            const built = newestExecutable(`${WS}/project/build`, 'test_calculator.out');
            checks.expect(executable === built, `from ${installation}: debug returned ${executable}, but Ceedling built ${built ?? 'nothing'}`);

            // eslint-disable-next-line no-await-in-loop -- as above
            const upgraded = await cover();
            // eslint-disable-next-line no-await-in-loop -- as above
            await engine.clobber(token());
            // eslint-disable-next-line no-await-in-loop -- as above
            const clean = await cover();
            checks.expect(upgraded === clean, `from ${installation}: coverage ${upgraded}, but a clobbered build's ${clean}`);
            console.log(`from ${installation}: debug ${executable}; coverage ${upgraded === clean ? 'matches a clobbered build' : 'differs from a clobbered build'}`);
        } finally {
            delete process.env.WHICH_CEEDLING;
            engine.dispose();
        }
    }
    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
});
