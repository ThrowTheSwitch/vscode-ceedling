import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { type CppUnitReport, parseCppUnitReport, readCppUnitReport, reportedNames, testResults } from '../../src/testResults';

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function parseFixture(...segments: string[]): Promise<unknown> {
    const data = fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
    return new xml2js.Parser({ explicitArray: false }).parseStringPromise(data);
}

for (const version of ['ceedling-1.0.0', 'ceedling-1.1.0']) {
    suite(`readCppUnitReport (${version}, mixed pass/fail/ignore report)`, () => {
        let report: CppUnitReport;
        suiteSetup(async () => {
            report = readCppUnitReport(await parseFixture(version, 'cppunit-report-mixed.xml'));
        });

        test('reads the single failed test with its location and message', () => {
            assert.deepStrictEqual(report.failed, [{
                name: 'test/test_calculator.c::test_add_should_ButIsDeliberatelyWrong',
                message: 'Expected 1 Was 5',
                line: 15,
            }]);
        });

        // xml2js yields an array for several <Test> entries and a bare object for one.
        test('reads both successful tests', () => {
            assert.deepStrictEqual(report.passed.map((t) => t.name), [
                'test/test_calculator.c::test_add_should_ReturnSum',
                'test/test_calculator.c::test_add_should_HandleNegatives',
            ]);
        });

        test('reads the single ignored test', () => {
            assert.deepStrictEqual(report.ignored.map((t) => t.name), ['test/test_calculator.c::test_should_BeIgnored']);
        });
    });

    // Ceedling writes an empty category as a self-closing element, e.g. <FailedTests/>, which
    // xml2js yields as an empty string.
    suite(`readCppUnitReport (${version}, empty self-closing categories)`, () => {
        test('reads empty categories as empty lists', async () => {
            const report = readCppUnitReport(await parseFixture(version, 'cppunit-report-empty-categories.xml'));
            assert.deepStrictEqual(report.failed, []);
            assert.deepStrictEqual(report.ignored, []);
            assert.strictEqual(report.passed.length, 1);
        });
    });
}

// Ceedling 1.1.0 adds a `name` attribute to <TestRun>, which xml2js puts under `TestRun.$`.
suite('readCppUnitReport (1.1.0 <TestRun name="..."> attribute)', () => {
    test('does not affect reading the categories', async () => {
        const report = readCppUnitReport(await parseFixture('ceedling-1.1.0', 'cppunit-report-mixed.xml'));
        assert.strictEqual(report.failed.length, 1);
        assert.strictEqual(report.passed.length, 2);
    });
});

suite('readCppUnitReport (crash and malformed input)', () => {
    test("reads a :use_backtrace: crash as a failure with its message and line", async () => {
        const report = readCppUnitReport(await parseFixture('ceedling-1.1.0', 'cppunit-report-crash.xml'));
        assert.strictEqual(report.failed[0].line, 12);
        assert.match(report.failed[0].message, /SIGSEGV/);
    });

    test('a failure without a <Location> has no line', () => {
        const report = readCppUnitReport({ TestRun: { FailedTests: { Test: { Name: 'f.c::t', Message: 'boom' } } } });
        assert.deepStrictEqual(report.failed, [{ name: 'f.c::t', message: 'boom', line: undefined }]);
    });

    test('a failure without a <Message> has an empty message', () => {
        const report = readCppUnitReport({ TestRun: { FailedTests: { Test: { Name: 'f.c::t', Location: { Line: '3' } } } } });
        assert.deepStrictEqual(report.failed, [{ name: 'f.c::t', message: '', line: 2 }]);
    });

    test('a shape with no TestRun is rejected', () => {
        assert.throws(() => readCppUnitReport({}));
        assert.throws(() => readCppUnitReport(undefined));
    });
});

suite('parseCppUnitReport', () => {
    test('parses report text', async () => {
        const text = fs.readFileSync(path.resolve(fixturesRoot, 'ceedling-1.1.0', 'cppunit-report-mixed.xml'), 'utf8');
        assert.strictEqual((await parseCppUnitReport(text)).passed.length, 2);
    });

    test('rejects malformed XML, as Ceedling before 1.2.0 writes for an unescaped `<`', async () => {
        await assert.rejects(parseCppUnitReport('<TestRun><SuccessfulTests><Test><Name>t(1 < 2)</Name></Test></SuccessfulTests></TestRun>'));
    });
});

suite('testResults', () => {
    const report: CppUnitReport = {
        passed: [{ name: 'f.c::test_a' }, { name: 'f.c::test_p(1)' }],
        failed: [{ name: 'f.c::test_b', message: 'Expected 1 Was 2', line: 9 }],
        ignored: [{ name: 'f.c::test_c' }],
    };

    test('maps each expected id to its reported result, in report order', () => {
        const { results, unmapped } = testResults(report, ['f.c::test_a', 'f.c::test_b', 'f.c::test_c', 'f.c::test_p(1)']);
        assert.deepStrictEqual(results, [
            { kind: 'skipped', id: 'f.c::test_c' },
            { kind: 'passed', id: 'f.c::test_a' },
            { kind: 'passed', id: 'f.c::test_p(1)' },
            { kind: 'failed', id: 'f.c::test_b', message: 'Expected 1 Was 2', line: 9 },
        ]);
        assert.deepStrictEqual(unmapped, []);
    });

    // An item that never gets a result would otherwise end its run silently as skipped.
    test('an expected id that Ceedling did not report is unreported', () => {
        const { results } = testResults(report, ['f.c::test_a', 'f.c::test_gone']);
        assert.deepStrictEqual(results.filter((r) => r.kind === 'unreported'), [{ kind: 'unreported', id: 'f.c::test_gone' }]);
    });

    test('a reported name matching no expected id is returned as unmapped, not as a result', () => {
        const { results, unmapped } = testResults(report, ['f.c::test_a']);
        assert.deepStrictEqual(results, [{ kind: 'passed', id: 'f.c::test_a' }]);
        assert.deepStrictEqual(unmapped, ['f.c::test_c', 'f.c::test_p(1)', 'f.c::test_b']);
    });
});

suite('reportedNames', () => {
    test('lists every reported test across categories', () => {
        const names = reportedNames({ passed: [{ name: 'a' }], failed: [{ name: 'b', message: '' }], ignored: [{ name: 'c' }] });
        assert.deepStrictEqual(names.sort(), ['a', 'b', 'c']);
    });
});
