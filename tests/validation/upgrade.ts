// A project built by an older Ceedling, then by the image's own, as after an upgrade. A newer
// layout moves a test's build output, and the older layout's files stay until a clobber. For each
// older installation under /opt/ceedling the image's launcher can run, through WHICH_CEEDLING, once
// with coverage counters reset before each coverage run and once with them kept:
// 1. The older Ceedling covers one test file and debug-builds a nested one, whose build directory
//    differs between layouts. Both must succeed, so the older layout's files exist.
// 2. With the image's own Ceedling, a debug build must return the executable just built, never the
//    one left in the older layout. Where that Ceedling moved the layout and found the older one's
//    dependency cache, it warns, and the engine must offer a clobber once. Elsewhere it must offer
//    none. A reworded warning the engine doesn't recognize fails here.
// 3. Reports read every counter on disk. With resets, coverage must equal a clobbered build's,
//    since the engine's reset clears the older layout's counters too. Without, where the layout
//    moved, coverage must differ from a clobbered build's, since reports count the older layout's
//    counters too. The clobber runs as the offer's does.
//
// usage: node upgrade.js
import * as fs from 'fs';
import semver from 'semver';
import { coverageMode } from '../../src/ceedlingEngine';
import { capabilitiesOf, ceedlingRelease } from '../../src/ceedlingVersions';
import type { CoverageOutcome } from '../../src/testModel';
import {
    builtExecutable, ceedlingAlone, ceedlingVersion, describeOutcome, executables, fileOf, INSTALLATIONS, leftovers, main, makeEngine, only, parseArgs,
    recordingReporter, removeExecutables, stage, token, WS,
} from './harness';

const COVERED = 'test/test_calculator.c';
// Flat before 1.2.0, below its test root from 1.2.0, and below the project root from 1.2.2.
const NESTED = 'test/unit/test_nested.c';
// The first release keeping a dependency cache, which a later layout's first build sets aside.
const FIRST_CACHED = '1.2.0';

main('upgrade', async (checks) => {
    parseArgs([]);
    const own = ceedlingVersion();
    const releaseOf = (name: string) => ceedlingRelease(name) ?? name;
    const older = fs.readdirSync(INSTALLATIONS).filter((name) => semver.lt(releaseOf(name), own)).sort((a, b) => semver.compare(releaseOf(a), releaseOf(b)));
    console.log(`Ceedling ${own}; upgrading from ${older.join(', ') || 'nothing older'}`);
    let upgraded = 0;

    for (const installation of older) {
        const moved = capabilitiesOf(own).projectPathTestNames && !capabilitiesOf(releaseOf(installation)).projectPathTestNames;
        const warns = moved && semver.gte(releaseOf(installation), FIRST_CACHED);
        for (const resets of [true, false]) {
            const label = `from ${installation}, counters ${resets ? 'reset' : 'kept'}`;
            fs.rmSync(`${WS}/project`, { recursive: true, force: true });
            stage('tests/validation/workspaces/coverage');
            fs.mkdirSync(`${WS}/project/test/unit`, { recursive: true });
            fs.writeFileSync(`${WS}/project/${NESTED}`, '#include "unity.h"\n\nvoid test_nested(void)\n{\n}\n');
            const settings = { projects: [{ path: 'project', debugLaunchConfig: 'dbg' }], mixins: [`${WS}/mixins/gcovr.yml`], coverageResetsCounters: resets };
            const { engine, upgrades } = makeEngine(settings);
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
                    console.log(`${label}: skipped, since the launcher can't run it`);
                    break;
                }
                // eslint-disable-next-line no-await-in-loop -- one installation at a time
                const before = await cover();
                // eslint-disable-next-line no-await-in-loop -- as above
                const oldBuild = await debug(true);
                checks.expect(before?.kind === 'report' && oldBuild.built !== undefined,
                    `${label}: the older Ceedling left ${describe(before)} and built ${oldBuild.built ?? 'no executable'}`);
                checks.expect(upgrades.length === 0, `${label}: the older Ceedling's own builds offered a clobber`);
                delete process.env.WHICH_CEEDLING;

                // eslint-disable-next-line no-await-in-loop -- as above
                const { executable } = await debug(false);
                // Where the layout moved, both executables now exist, and the newer is this build's.
                const newest = executables(`${WS}/project/build`, 'test_nested.out').shift();
                checks.expect(executable === newest, `${label}: debug returned ${executable}, but Ceedling last built ${newest ?? 'nothing'}, after the older Ceedling's ${oldBuild.built}`);
                // eslint-disable-next-line no-await-in-loop -- as above
                const after = describe(await cover());
                checks.expect(upgrades.length === (warns ? 1 : 0),
                    `${label}: the engine offered ${upgrades.length} clobbers, but Ceedling ${warns ? 'warns of' : 'has no'} a layout upgrade`);
                const notice = upgrades[0]?.message ?? '';
                if (warns) {
                    checks.expect(resets ? /coverage stays exact/i.test(notice) : /coverage reports also count/i.test(notice), `${label}: the notice reads "${notice}"`);
                }
                // eslint-disable-next-line no-await-in-loop -- as above
                checks.expect(await engine.clobberProject(upgrades[0]?.projectKey ?? 'project', token()), `${label}: the clobber failed`);
                // eslint-disable-next-line no-await-in-loop -- as above
                const clean = await cover();
                checks.expect(clean?.kind === 'report', `${label}: a clobbered build's coverage is ${describe(clean)}`);
                // Kept counters in an unmoved layout accumulate, as the setting intends.
                if (resets) {
                    checks.expect(after === describe(clean), `${label}: coverage ${after}, but a clobbered build's ${describe(clean)}`);
                } else if (moved) {
                    checks.expect(after !== describe(clean), `${label}: coverage ${after} counts no older counters, though the older layout left them`);
                }
                if (resets) upgraded++;
                console.log(`${label}: debug ${executable}, after ${oldBuild.built}; ${upgrades.length} clobber offered; coverage ${after}, clobbered ${describe(clean)}`);
            } catch (error) {
                checks.fail(`${label} threw: ${error instanceof Error ? error.stack : String(error)}`);
            } finally {
                delete process.env.WHICH_CEEDLING;
                engine.dispose();
            }
        }
    }
    console.log(`upgraded from ${upgraded} of ${older.length} older installations`);
    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
});
