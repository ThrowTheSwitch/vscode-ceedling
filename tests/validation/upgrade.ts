// A project built by an older Ceedling, then by the image's own, as after an upgrade. A newer
// layout moves a test's build output, and the older layout's files stay until a clobber. For each
// older installation under /opt/ceedling the image's launcher can run, through WHICH_CEEDLING:
// 1. The older Ceedling covers one test file and debug-builds a nested one, whose build directory
//    differs between layouts. Both must succeed, so the older layout's files exist.
// 2. With the image's own Ceedling, a debug build must return the executable just built, never the
//    one left in the older layout.
// 3. Coverage must equal coverage of a clobbered build. Reports read every counter on disk, so the
//    engine's counter reset must clear the older layout's too.
//
// usage: node upgrade.js
import * as fs from 'fs';
import semver from 'semver';
import { coverageMode } from '../../src/ceedlingEngine';
import { ceedlingRelease } from '../../src/ceedlingProjectConfig';
import type { CoverageOutcome } from '../../src/testModel';
import {
    builtExecutable, ceedlingAlone, ceedlingVersion, describeOutcome, executables, fileOf, INSTALLATIONS, leftovers, main, makeEngine, only, parseArgs,
    recordingReporter, removeExecutables, stage, token, WS,
} from './harness';

const COVERED = 'test/test_calculator.c';
// Flat before 1.2.0, below its test root from 1.2.0, and below the project root from 1.2.2.
const NESTED = 'test/unit/test_nested.c';

main('upgrade', async (checks) => {
    parseArgs([]);
    const own = ceedlingVersion();
    const releaseOf = (name: string) => ceedlingRelease(name) ?? name;
    const older = fs.readdirSync(INSTALLATIONS).filter((name) => semver.lt(releaseOf(name), own)).sort((a, b) => semver.compare(releaseOf(a), releaseOf(b)));
    console.log(`Ceedling ${own}; upgrading from ${older.join(', ') || 'nothing older'}`);
    const settings = { projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [`${WS}/mixins/gcovr.yml`] };
    let upgraded = 0;

    for (const installation of older) {
        fs.rmSync(`${WS}/project`, { recursive: true, force: true });
        stage('tests/validation/workspaces/coverage');
        fs.mkdirSync(`${WS}/project/test/unit`, { recursive: true });
        fs.writeFileSync(`${WS}/project/${NESTED}`, '#include "unity.h"\n\nvoid test_nested(void)\n{\n}\n');
        const { engine } = makeEngine(settings);
        const cover = async (): Promise<CoverageOutcome | undefined> => {
            const reporter = recordingReporter();
            await engine.runFile('project', fileOf(only(await engine.discover()), COVERED), reporter, token(), coverageMode());
            return reporter.last();
        };
        // The older Ceedling's executable stays, for the newer debug build to tell apart from its own.
        const debug = async (fresh: boolean): Promise<{ executable: string | undefined, built: string | undefined }> => {
            if (fresh) removeExecutables(`${WS}/project/build`, 'test_nested.out');
            const executable = await engine.compileForDebug('project', fileOf(only(await engine.discover()), NESTED), recordingReporter(), token());
            return { executable, built: builtExecutable(`${WS}/project/build`, 'test_nested.out') };
        };
        const describe = (outcome: CoverageOutcome | undefined) => outcome ? describeOutcome(outcome) : 'no coverage';
        try {
            process.env.WHICH_CEEDLING = `${INSTALLATIONS}/${installation}`;
            if (!ceedlingAlone(['test:all', '--mixin', `${WS}/mixins/gcovr.yml`], `${WS}/project`).runs) {
                console.log(`from ${installation}: skipped, since the launcher can't run it`);
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- one installation at a time
            const before = await cover();
            // eslint-disable-next-line no-await-in-loop -- as above
            const oldBuild = await debug(true);
            checks.expect(before?.kind === 'report' && oldBuild.built !== undefined,
                `from ${installation}: the older Ceedling left ${describe(before)} and built ${oldBuild.built ?? 'no executable'}`);
            delete process.env.WHICH_CEEDLING;

            // eslint-disable-next-line no-await-in-loop -- as above
            const { executable } = await debug(false);
            // Where the layout moved, both executables now exist, and the newer is this build's.
            const newest = executables(`${WS}/project/build`, 'test_nested.out').shift();
            checks.expect(executable === newest, `from ${installation}: debug returned ${executable}, but Ceedling last built ${newest ?? 'nothing'}, after the older Ceedling's ${oldBuild.built}`);
            // eslint-disable-next-line no-await-in-loop -- as above
            const after = describe(await cover());
            // eslint-disable-next-line no-await-in-loop -- as above
            await engine.clobber(token());
            // eslint-disable-next-line no-await-in-loop -- as above
            const clean = await cover();
            checks.expect(clean?.kind === 'report', `from ${installation}: a clobbered build's coverage is ${describe(clean)}`);
            checks.expect(after === describe(clean), `from ${installation}: coverage ${after}, but a clobbered build's ${describe(clean)}`);
            upgraded++;
            console.log(`from ${installation}: debug ${executable}, after ${oldBuild.built}; coverage ${after === describe(clean) ? 'matches a clobbered build' : 'differs from a clobbered build'}`);
        } catch (error) {
            checks.fail(`from ${installation} threw: ${error instanceof Error ? error.stack : String(error)}`);
        } finally {
            delete process.env.WHICH_CEEDLING;
            engine.dispose();
        }
    }
    console.log(`upgraded from ${upgraded} of ${older.length} older installations`);
    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
});
