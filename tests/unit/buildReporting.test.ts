import * as assert from 'assert';
import { type BuildOutcome, reportOf, transcriptOf } from '../../src/buildReporting';
import type { RunReporter } from '../../src/testModel';

function recorder(): RunReporter & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const record = (kind: string) => (...args: unknown[]) => { calls.push([kind, ...args]); };
    return {
        calls, started: record('started'), passed: record('passed'), failed: record('failed'), skipped: record('skipped'),
        errored: record('errored'), appendOutput: record('appendOutput'), coverage: record('coverage'),
    };
}

suite('transcriptOf', () => {
    test('labels each stream that has output', () => {
        assert.strictEqual(transcriptOf({ stdout: 'OUT', stderr: 'ERR' }), 'stdout:\nOUT\nstderr:\nERR');
        assert.strictEqual(transcriptOf({ stdout: '', stderr: 'ERR' }), 'stderr:\nERR');
        assert.strictEqual(transcriptOf({ stdout: '', stderr: '' }), '');
    });
});

type Completed = Extract<BuildOutcome, { cancelled: false }>;

suite('reportOf', () => {
    const built = (report: Completed['report']): Completed =>
        ({ cancelled: false, transcript: 'stderr:\nboom', exception: undefined, diagnostics: [], report, coverage: undefined });

    test("a cancelled build skips its leaves and has nothing to map", () => {
        const reporter = recorder();
        assert.strictEqual(reportOf({ cancelled: true }, ['f', 'f::a'], ['f::a'], reporter), undefined);
        assert.deepStrictEqual(reporter.calls, [['skipped', 'f::a']]);
    });

    test('a build without a report errors every id, its first diagnostic leading by severity', () => {
        const reporter = recorder();
        const outcome: Completed = {
            ...built(undefined),
            diagnostics: [
                { file: '/a.h', message: 'a warning', severity: 'warning', startLine: 1, startColumn: 0, endLine: 1, endColumn: 999 },
                { file: '/t.c', message: 'the error', severity: 'error', startLine: 7, startColumn: 0, endLine: 7, endColumn: 999 },
            ],
        };
        assert.strictEqual(reportOf(outcome, ['f', 'f::a'], ['f::a'], reporter), undefined);
        assert.deepStrictEqual(reporter.calls.map((c) => c.slice(0, 2)), [['errored', 'f'], ['errored', 'f::a']]);
        assert.match(String(reporter.calls[0]?.[2]), /^the error\n\nstderr:\nboom$/);
        assert.deepStrictEqual(reporter.calls[0]?.[3], { file: '/t.c', line: 7 });
    });

    test('a build with a report returns it, reporting nothing yet', () => {
        const reporter = recorder();
        const report = { passed: [], failed: [], ignored: [] } as unknown as NonNullable<Completed['report']>;
        assert.strictEqual(reportOf(built(report), ['f'], [], reporter)?.report, report);
        assert.deepStrictEqual(reporter.calls, []);
    });
});
