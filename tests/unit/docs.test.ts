import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { capabilitiesOf, type CeedlingFeature, firstRelease, launcherCapabilitiesOf, type LauncherFeature } from '../../src/ceedlingVersions';

// Documentation that restates code, checked against it so the two can't drift apart.
suite('Architecture.md', () => {
    // Its version table lists every feature with its first release, application's or launcher's.
    test('the version table lists every feature at its first release', () => {
        const architecture = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'Architecture.md'), 'utf8');
        const rows = [...architecture.matchAll(/^\| `(\w+)` \| (\d+\.\d+\.\d+) \| (Application|Launcher) \|/gm)].map((m) => `${m[3]} ${m[1]} ${m[2]}`).sort();
        const features = [
            ...(Object.keys(capabilitiesOf('1.0.0')) as CeedlingFeature[]).map((f) => `Application ${f} ${firstRelease(f)}`),
            ...(Object.keys(launcherCapabilitiesOf('1.0.0')) as LauncherFeature[]).map((f) => `Launcher ${f} ${firstRelease(f)}`),
        ].sort();
        assert.deepStrictEqual(rows, features);
    });
});
