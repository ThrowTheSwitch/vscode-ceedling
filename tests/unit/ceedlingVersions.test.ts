import * as assert from 'assert';
import {
    applicationRelease,
    capabilitiesOf,
    type CeedlingFeature,
    ceedlingRelease,
    firstRelease,
    isSupportedRelease,
    launcherCapabilitiesOf,
    type LauncherFeature,
    MINIMUM_CEEDLING_VERSION,
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
