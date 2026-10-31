import * as assert from 'assert';
import {
    applicationRelease,
    capabilitiesOf,
    type CeedlingFeature,
    checkVersion,
    ceedlingRelease,
    firstRelease,
    isSupportedRelease,
    launcherCapabilitiesOf,
    type LauncherFeature,
    launcherCapabilitiesOf as launcherOf,
    MINIMUM_CEEDLING_VERSION,
    releaseKnown,
    versionSeesSelection,
} from '../../src/ceedlingVersions';

suite('Ceedling releases', () => {
    // Real builds report a commit suffix, e.g. 1.2.0-13a540f, which semver ranks below 1.2.0.
    test('a reported version counts as its release, build suffix and all', () => {
        assert.deepStrictEqual(['1.2.0', '1.2.0-13a540f', '1.2.1.dev', 'v1.1.10'].map(ceedlingRelease), ['1.2.0', '1.2.0', '1.2.1', '1.1.10']);
    });

    test('a version with no release in it has none', () => {
        assert.strictEqual(ceedlingRelease('unknown'), undefined);
    });

    test('releases from 1.0.0 are supported', () => {
        assert.strictEqual(MINIMUM_CEEDLING_VERSION, '1.0.0');
        assert.deepStrictEqual(['0.31.1', '1.0.0', '1.3.0'].map(isSupportedRelease), [false, true, true]);
    });

    test('each capability holds from its first release, and not in the release before', () => {
        assert.strictEqual(firstRelease('pathQualifiedCoverageTasks'), '1.2.1');
        const previous: Record<string, string> = { '1.2.0': '1.1.10', '1.2.1': '1.2.0', '1.2.2': '1.2.1' };
        const known = (feature: string, first: string) => assert.ok(first in previous, `${feature} from ${first}, a release this test doesn't know`);
        for (const feature of Object.keys(capabilitiesOf('1.0.0')) as CeedlingFeature[]) {
            const first = firstRelease(feature);
            known(feature, first);
            assert.strictEqual(capabilitiesOf(first)[feature], true, `${feature} at ${first}`);
            assert.strictEqual(capabilitiesOf(previous[first])[feature], false, `${feature} before ${first}`);
        }
        for (const feature of Object.keys(launcherCapabilitiesOf('1.0.0')) as LauncherFeature[]) {
            const first = firstRelease(feature);
            known(feature, first);
            assert.strictEqual(launcherCapabilitiesOf(first)[feature], true, `launcher ${feature} at ${first}`);
            assert.strictEqual(launcherCapabilitiesOf(previous[first])[feature], false, `launcher ${feature} before ${first}`);
        }
    });

    // A feature belongs to the application or the launcher, never both, so code can't ask the wrong one.
    test('no feature is both an application and a launcher feature', () => {
        const application = Object.keys(capabilitiesOf('1.0.0'));
        assert.deepStrictEqual(Object.keys(launcherCapabilitiesOf('1.0.0')).filter((f) => application.includes(f)), []);
    });

    test('a Ceedling that runs no other installation reports its own release exactly', () => {
        assert.deepStrictEqual(applicationRelease({ application: '1.2.0-13a540f' }), { release: '1.2.0', exactRelease: true });
    });

    // Before 1.2.2 a launcher reports another installation as its own release with that
    // installation's commit (Ceedling#1365). Only the same commit shows the same build.
    test('before Ceedling 1.2.2, a launcher reports another installation exactly only when it is the same build', () => {
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.1-47d2c5e', application: '1.2.1-47d2c5e' }), { release: '1.2.1', exactRelease: true });
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.1-47d2c5e', application: '1.2.1-13a540f' }), { release: '1.2.1', exactRelease: false });
        assert.deepStrictEqual(applicationRelease({ launcher: '1.1.10', application: '1.1.10' }), { release: '1.1.10', exactRelease: false });
    });

    test("from Ceedling 1.2.2, a launcher reports another installation's own release exactly", () => {
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.2-0a1b2c3', application: '1.2.0-13a540f' }), { release: '1.2.0', exactRelease: true });
        assert.deepStrictEqual(applicationRelease({ launcher: '1.2.2', application: '1.2.1' }), { release: '1.2.1', exactRelease: true });
    });

    test("a launcher's features follow its own release", () => {
        assert.deepStrictEqual(['1.2.1-47d2c5e', '1.2.2.dev', '1.3.0'].map((v) => launcherCapabilitiesOf(v).reportsApplicationVersion), [false, true, true]);
    });

    test('a report naming no release for either Ceedling has none', () => {
        assert.strictEqual(applicationRelease({ application: 'unknown' }), undefined);
        assert.strictEqual(applicationRelease({ launcher: 'unknown', application: '1.2.0' }), undefined);
    });
});

suite('capabilitiesOf', () => {
    const none = {
        dumpconfigStdout: false, forceTestRerun: false, pathQualifiedTestTasks: false, pathQualifiedCoverageTasks: false, ceedlingYml: false, nestedTestBuilds: false,
        readOnlyDiscovery: false, projectPathTestNames: false,
    };

    test('Ceedling before 1.2.0 has none of the 1.2.0 features', () => {
        for (const version of ['1.0.0', '1.1.10', '1.1.10-85ec551']) {
            assert.deepStrictEqual(capabilitiesOf(version), none);
        }
    });

    // Real 1.2.0 builds report a commit suffix, e.g. 1.2.0-13a540f, which semver ranks below 1.2.0.
    // 1.2.0's gcov: tasks still take only a bare file name.
    test("Ceedling 1.2.0, build suffix included, has every 1.2.0 feature and none of 1.2.1's", () => {
        for (const version of ['1.2.0', '1.2.0-13a540f']) {
            assert.deepStrictEqual(capabilitiesOf(version), { ...none, dumpconfigStdout: true, forceTestRerun: true, pathQualifiedTestTasks: true, ceedlingYml: true, nestedTestBuilds: true });
        }
    });

    const v121 = { dumpconfigStdout: true, forceTestRerun: true, pathQualifiedTestTasks: true, pathQualifiedCoverageTasks: true, ceedlingYml: true, nestedTestBuilds: true, readOnlyDiscovery: true };

    test("Ceedling 1.2.1, build suffix included, also takes paths in coverage tasks and discovers without writing, but has none of 1.2.2's", () => {
        for (const version of ['1.2.1', '1.2.1-0a1b2c3']) {
            assert.deepStrictEqual(capabilitiesOf(version), { ...v121, projectPathTestNames: false });
        }
    });

    test('Ceedling 1.2.2 and later, build suffix included, also name each test by its path from the project root', () => {
        for (const version of ['1.2.2', '1.2.2-0a1b2c3', '1.2.2.dev', '1.3.1']) {
            assert.deepStrictEqual(capabilitiesOf(version), { ...v121, projectPathTestNames: true });
        }
    });
});

// Before 1.2.2 `ceedling version` never reads :which_ceedling:, so its report covers a project only
// when the setting picks what `version` picks unaided: the installed gem, or vendor/ceedling.
suite('versionSeesSelection', () => {
    for (const which of ['gem', 'GEM', ' Gem ', 'vendor/ceedling', './vendor/ceedling/', 'vendor//ceedling', '/ws/vendor/ceedling']) {
        test(`'${which}' is seen`, () => assert.strictEqual(versionSeesSelection(which, '/ws', 'linux'), true));
    }
    for (const which of ['tools/ceedling', 'vendor/ceedling/sub', '../vendor/ceedling', '/opt/ceedling', 'VENDOR/ceedling', 'gems']) {
        test(`'${which}' isn't seen`, () => assert.strictEqual(versionSeesSelection(which, '/ws', 'linux'), false));
    }
    for (const which of ['vendor\\ceedling', 'Vendor\\Ceedling\\', 'c:\\ws\\vendor\\ceedling', 'C:/WS/vendor/ceedling']) {
        test(`on Windows, '${which}' is seen`, () => assert.strictEqual(versionSeesSelection(which, 'C:\\ws', 'win32'), true));
    }
});

suite('checkVersion', () => {
    const log = { debug: () => { /* unread */ } };
    const result = (stdout: string, stderr = '') => ({ error: null, stdout, stderr, cancelled: false });
    const single = (version: string) => result(`Welcome to Ceedling!\n  Ceedling => ${version}\n`);
    const launching = (launcher: string, application: string) => result(`  Ceedling Launcher => ${launcher}\n  Ceedling App => ${application}\n`);
    const runs = (...results: ReturnType<typeof result>[]) => {
        const asked: boolean[] = [];
        return { asked, run: async (withProject: boolean) => { asked.push(withProject); return results.shift() ?? result(''); } };
    };

    test("a launcher before 1.2.2 is asked once, bare, and its own release is exact", async () => {
        const { asked, run } = runs(single('1.2.1'));
        const check = await checkVersion('p', run, log);
        assert.deepStrictEqual(asked, [false]);
        assert.ok(check.kind === 'checked' && check.ceedling.release === '1.2.1' && check.ceedling.exactRelease && check.warning === undefined);
    });

    // From 1.2.2 the second check, with the project's own arguments, sees a selection in its configuration.
    test('a 1.2.2 launcher is asked again with the project, whose report stands', async () => {
        const { asked, run } = runs(single('1.2.2'), launching('1.2.2', '1.1.10'));
        const check = await checkVersion('p', run, log);
        assert.deepStrictEqual(asked, [false, true]);
        assert.ok(check.kind === 'checked' && check.ceedling.release === '1.1.10' && check.ceedling.launcher.versionReadsProject);
    });

    test("another build behind an older launcher is a guess, with a warning", async () => {
        const check = await checkVersion('p', runs(launching('1.2.1-47d2c5e', '1.2.1-13a540f')).run, log);
        assert.ok(check.kind === 'checked' && !check.ceedling.exactRelease);
        assert.match(check.warning ?? '', /can't tell its release.*Ceedling#1365/);
    });

    test("an exception is the project's configuration problem, quoting it, from either check", async () => {
        const stopped = result('', 'EXCEPTION: Mixin bad.yml not found\n');
        for (const results of [[stopped], [single('1.2.2'), stopped]]) {
            // eslint-disable-next-line no-await-in-loop -- one case at a time
            const check = await checkVersion('p', runs(...results).run, log);
            assert.ok(check.kind === 'configuration' && /project 'p'[\s\S]*EXCEPTION: Mixin bad\.yml not found/.test(check.message), JSON.stringify(check));
        }
    });

    test('no version at all, or one too old, is an unusable Ceedling', async () => {
        const silent = await checkVersion('p', runs(result('')).run, log);
        assert.ok(silent.kind === 'unusable' && /Could not run 'ceedling version'/.test(silent.message));
        const old = await checkVersion('p', runs(single('0.31.1')).run, log);
        assert.ok(old.kind === 'unusable' && /0\.31\.1 is not supported/.test(old.message));
    });

    test("the runner's own failure reaches the caller", async () => {
        await assert.rejects(checkVersion('p', () => Promise.reject(new Error('spawn failed')), log), /spawn failed/);
    });
});

suite('releaseKnown', () => {
    const ceedling = (exactRelease: boolean, launcher: string) => ({ exactRelease, launcher: launcherOf(launcher) });

    test('a 1.2.2 launcher\'s exact report stands, whatever the configuration selects', () => {
        assert.ok(releaseKnown(ceedling(true, '1.2.2'), '/ws', undefined, 'linux'));
        assert.ok(!releaseKnown(ceedling(false, '1.2.2'), '/ws', 'gem', 'linux'));
    });

    // An older launcher never reads the project, so it stands only for what it would find unaided.
    test("an older launcher's stands only for a known selection it sees unaided", () => {
        assert.ok(releaseKnown(ceedling(true, '1.2.1'), '/ws', 'gem', 'linux'));
        assert.ok(releaseKnown(ceedling(true, '1.2.1'), '/ws', 'vendor/ceedling', 'linux'));
        assert.ok(!releaseKnown(ceedling(true, '1.2.1'), '/ws', '/opt/ceedling/1.0.0', 'linux'));
        assert.ok(!releaseKnown(ceedling(true, '1.2.1'), '/ws', undefined, 'linux'));
    });
});
