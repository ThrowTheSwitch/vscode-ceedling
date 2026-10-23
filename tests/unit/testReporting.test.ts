import * as assert from 'assert';
import * as path from 'path';
import { createRunReporter, type ReportMessage, type RunSink } from '../../src/testReporting';

type Item = { id: string };
type SinkCall = [string, ...unknown[]];

function recordingSink(): RunSink<Item> & { calls: SinkCall[] } {
    const calls: SinkCall[] = [];
    return {
        calls,
        started: (item) => calls.push(['started', item.id]),
        passed: (item) => calls.push(['passed', item.id]),
        failed: (item, message) => calls.push(['failed', item.id, message]),
        skipped: (item) => calls.push(['skipped', item.id]),
        errored: (item, message) => calls.push(['errored', item.id, message]),
        appendOutput: (text) => calls.push(['appendOutput', text]),
        coverage: (outcome) => calls.push(['coverage', outcome]),
    };
}

function reporterFor(ids: string[], options: { excluded?: string[], projectAbsPath?: () => string } = {}) {
    const sink = recordingSink();
    const warnings: string[] = [];
    const items = new Map(ids.map((id) => [id, { id }]));
    const reporter = createRunReporter<Item>({
        sink,
        projectKey: 'fw',
        find: (id) => items.get(id),
        excluded: (item) => (options.excluded ?? []).includes(item.id),
        projectAbsPath: options.projectAbsPath ?? (() => '/ws/fw'),
        warn: (message) => warnings.push(message),
    });
    return { reporter, sink, warnings };
}

suite('createRunReporter', () => {
    test('each result reaches the test run against its item', () => {
        const { reporter, sink } = reporterFor(['a', 'b', 'c']);
        reporter.started('a');
        reporter.passed('a');
        reporter.skipped('b');
        reporter.appendOutput('text\r\n');
        assert.deepStrictEqual(sink.calls, [['started', 'a'], ['passed', 'a'], ['skipped', 'b'], ['appendOutput', 'text\r\n']]);
    });

    // Coverage belongs to the run, not to any one test, so no item lookup applies.
    test('coverage reaches the test run as reported', () => {
        const { reporter, sink, warnings } = reporterFor([]);
        reporter.coverage({ kind: 'missing', message: 'no report' });
        assert.deepStrictEqual(sink.calls, [['coverage', { kind: 'missing', message: 'no report' }]]);
        assert.deepStrictEqual(warnings, []);
    });

    test('a result for an id with no item is dropped, with a warning naming the id and project', () => {
        const { reporter, sink, warnings } = reporterFor(['a']);
        reporter.passed('gone');
        reporter.failed('gone', 'message', 3);
        assert.deepStrictEqual(sink.calls, []);
        assert.strictEqual(warnings.length, 2);
        assert.match(warnings[0], /passed.*'gone'.*'fw'/);
        assert.match(warnings[1], /failed.*'gone'.*'fw'/);
    });

    // A run can't always leave an excluded test out of what Ceedling runs, e.g. one case of a function.
    test('an excluded item gets no result, and no warning', () => {
        const { reporter, sink, warnings } = reporterFor(['a', 'b'], { excluded: ['b'] });
        reporter.started('b');
        reporter.failed('b', 'message');
        reporter.errored('b', 'message');
        reporter.passed('a');
        assert.deepStrictEqual(sink.calls, [['passed', 'a']]);
        assert.deepStrictEqual(warnings, []);
    });

    test('a failure points at its line in the test file, when it has one', () => {
        const { reporter, sink } = reporterFor(['a', 'b']);
        reporter.failed('a', 'Expected 1 Was 2', 4);
        reporter.failed('b', 'no location');
        assert.deepStrictEqual(sink.calls, [
            ['failed', 'a', { text: 'Expected 1 Was 2', location: { line: 4 } } satisfies ReportMessage],
            ['failed', 'b', { text: 'no location' } satisfies ReportMessage],
        ]);
    });

    // Ceedling 1.1.0+'s :use_backtrace: :gdb ends a crash message with the gdb log's path.
    test("a crash's gdb log becomes a link to it, resolved against the project directory", () => {
        const { reporter, sink } = reporterFor(['a']);
        reporter.failed('a', 'Test crashed\n(build/test/test_calc.gdb.log)', 7);
        assert.deepStrictEqual(sink.calls, [['failed', 'a', {
            text: 'Test crashed',
            log: { label: 'build/test/test_calc.gdb.log', absPath: path.resolve('/ws/fw', 'build/test/test_calc.gdb.log') },
            location: { line: 7 },
        } satisfies ReportMessage]]);
    });

    test('the project directory is looked up only for a gdb log link', () => {
        let lookups = 0;
        const { reporter } = reporterFor(['a'], { projectAbsPath: () => { lookups++; return '/ws/fw'; } });
        reporter.failed('a', 'plain failure', 1);
        assert.strictEqual(lookups, 0);
        reporter.failed('a', 'crash\n(x.gdb.log)', 1);
        assert.strictEqual(lookups, 1);
    });

    test("an error points at its diagnostic's own file, which may be a header", () => {
        const { reporter, sink } = reporterFor(['a', 'b']);
        reporter.errored('a', 'compile failed', { file: '/ws/fw/src/calc.h', line: 2 });
        reporter.errored('b', 'no report');
        assert.deepStrictEqual(sink.calls, [
            ['errored', 'a', { text: 'compile failed', location: { file: '/ws/fw/src/calc.h', line: 2 } } satisfies ReportMessage],
            ['errored', 'b', { text: 'no report' } satisfies ReportMessage],
        ]);
    });
});
