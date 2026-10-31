// Reads Ceedling's CppUnit XML test report and maps it onto discovered test ids. The report comes
// from the report_tests_log_factory plugin, which the extension's bundled mixin always enables.
// It has no `vscode` or filesystem dependency, so it is unit-tested in plain Node.

import { field, list, parseXml, text } from './parsedXml';

export type ReportedTest = { name: string };
// `line` is 0-based. A failure Ceedling reports without a location has none.
export type ReportedFailure = { name: string, message: string, line?: number };
export type CppUnitReport = { passed: ReportedTest[], failed: ReportedFailure[], ignored: ReportedTest[] };

// `unreported` marks an id the run should have produced a result for but didn't. Ceedling names
// tests itself, so this means discovery and Ceedling disagree about a name.
export type TestResult =
    | { kind: 'passed', id: string }
    | { kind: 'skipped', id: string }
    | { kind: 'failed', id: string, message: string, line?: number }
    | { kind: 'unreported', id: string };

// Rejects malformed XML. Ceedling before 1.2.0 writes `<` and `&` in test names unescaped.
export async function parseCppUnitReport(text: string): Promise<CppUnitReport> {
    return readCppUnitReport(await parseXml(text));
}

// Reads a report as xml2js parses it with `explicitArray: false`. Throws when there is no <TestRun>
// at all.
export function readCppUnitReport(parsedXml: unknown): CppUnitReport {
    const testRun = field(parsedXml, 'TestRun');
    if (typeof testRun !== 'object' || testRun === null) {
        throw new Error('The CppUnit report has no <TestRun> element.');
    }
    return {
        passed: category(testRun, 'SuccessfulTests').map((test) => ({ name: text(field(test, 'Name')) })),
        failed: category(testRun, 'FailedTests').map((test) => {
            const line = parseInt(text(field(test, 'Location', 'Line')), 10);
            return { name: text(field(test, 'Name')), message: text(field(test, 'Message')), line: Number.isFinite(line) ? line - 1 : undefined };
        }),
        ignored: category(testRun, 'IgnoredTests').map((test) => ({ name: text(field(test, 'Name')) })),
    };
}

function category(testRun: object, name: string): unknown[] {
    return list(field(testRun, name, 'Test'));
}

export function reportedNames(report: CppUnitReport): string[] {
    return [...report.ignored, ...report.passed, ...report.failed].map((test) => test.name);
}

// Results for the expected ids only, in report order: ignored, passed, then failed. Then each
// expected id Ceedling didn't report. `unmapped` lists reported names matching no expected id.
export function testResults(report: CppUnitReport, expectedIds: readonly string[]): { results: TestResult[], unmapped: string[] } {
    const expected = new Set(expectedIds);
    const reported = new Set<string>();
    const results: TestResult[] = [];
    const unmapped: string[] = [];
    const add = (name: string, result: TestResult) => {
        reported.add(name);
        if (expected.has(name)) {
            results.push(result);
        } else {
            unmapped.push(name);
        }
    };
    for (const { name } of report.ignored) {
        add(name, { kind: 'skipped', id: name });
    }
    for (const { name } of report.passed) {
        add(name, { kind: 'passed', id: name });
    }
    for (const { name, message, line } of report.failed) {
        add(name, { kind: 'failed', id: name, message, line });
    }
    for (const id of expectedIds) {
        if (!reported.has(id)) {
            results.push({ kind: 'unreported', id });
        }
    }
    return { results, unmapped };
}
