import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// Namespace import, not a default import: test.tsconfig.json has no esModuleInterop (unlike the
// root tsconfig.json, which production code relies on for `import xml2js from 'xml2js'`), and
// @types/xml2js has no default export - only this form type-checks here.
import * as xml2js from 'xml2js';
import { getTestListFromXmlReport } from '../../src/ceedlingXmlReport';

// __dirname at runtime is out/tests/unit (tsc mirrors the source tree under outDir); fixtures are
// plain data files tsc doesn't copy into out/, so walk back up to the repo root to find them.
const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function parseFixture(...segments: string[]): Promise<any> {
    const data = fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
    const parser = new xml2js.Parser({ explicitArray: false });
    return new Promise((resolve, reject) => {
        parser.parseString(data, (error: any, result: any) => error ? reject(error) : resolve(result));
    });
}

for (const version of ['ceedling-1.0.0', 'ceedling-1.1.0']) {
    suite(`getTestListFromXmlReport (${version}, mixed pass/fail/ignore report)`, () => {
        let report: any;
        suiteSetup(async () => {
            report = await parseFixture(version, 'cppunit-report-mixed.xml');
        });

        test('returns the single failed test with its location and message', () => {
            const failed = getTestListFromXmlReport(report, 'FailedTests');
            assert.strictEqual(failed.length, 1);
            assert.strictEqual(failed[0]['Name'], 'test/test_calculator.c::test_add_should_ButIsDeliberatelyWrong');
            assert.strictEqual(failed[0]['Location']['Line'], '16');
            assert.strictEqual(failed[0]['Message'], 'Expected 1 Was 5');
        });

        test('returns both successful tests (multi-item array, not normalized)', () => {
            const passed = getTestListFromXmlReport(report, 'SuccessfulTests');
            assert.deepStrictEqual(passed.map((t: any) => t['Name']), [
                'test/test_calculator.c::test_add_should_ReturnSum',
                'test/test_calculator.c::test_add_should_HandleNegatives',
            ]);
        });

        test('returns the single ignored test (single-item, normalized into an array)', () => {
            const ignored = getTestListFromXmlReport(report, 'IgnoredTests');
            assert.strictEqual(ignored.length, 1);
            assert.strictEqual(ignored[0]['Name'], 'test/test_calculator.c::test_should_BeIgnored');
        });
    });

    // Direct regression test for the confirmed-safe behavior: a self-closing empty category
    // (e.g. <FailedTests/>, which Ceedling emits when a run has no failures) parses via
    // `explicitArray: false` to an empty string, and must be normalized to [], not crash on
    // `undefined["Name"]`.
    suite(`getTestListFromXmlReport (${version}, empty self-closing categories)`, () => {
        let report: any;
        suiteSetup(async () => {
            report = await parseFixture(version, 'cppunit-report-empty-categories.xml');
        });

        test('returns [] for an empty FailedTests category', () => {
            assert.deepStrictEqual(getTestListFromXmlReport(report, 'FailedTests'), []);
        });

        test('returns [] for an empty IgnoredTests category', () => {
            assert.deepStrictEqual(getTestListFromXmlReport(report, 'IgnoredTests'), []);
        });

        test('still returns the single successful test', () => {
            const passed = getTestListFromXmlReport(report, 'SuccessfulTests');
            assert.strictEqual(passed.length, 1);
        });
    });
}

// Direct regression test for the confirmed-safe behavior: Ceedling 1.1.0 adds a `name` attribute
// to the root <TestRun> element (from a new :project: :name: yml key). With
// `explicitArray: false` (no mergeAttrs), that lands under a sibling `TestRun.$` key and must not
// disturb traversal into the category keys.
suite('getTestListFromXmlReport (1.1.0 <TestRun name="..."> attribute)', () => {
    test('does not affect category traversal', async () => {
        const report = await parseFixture('ceedling-1.1.0', 'cppunit-report-mixed.xml');
        assert.strictEqual(report['TestRun']['$']['name'], 'Example Project');
        assert.strictEqual(getTestListFromXmlReport(report, 'FailedTests').length, 1);
        assert.strictEqual(getTestListFromXmlReport(report, 'SuccessfulTests').length, 2);
    });
});

suite('getTestListFromXmlReport (malformed input)', () => {
    test('throws on a shape with no TestRun key', () => {
        assert.throws(() => getTestListFromXmlReport({}, 'FailedTests'));
    });
});
