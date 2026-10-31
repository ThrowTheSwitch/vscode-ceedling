import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    getGccPatternsPreset,
    getPatternProblems,
    getPatternsPreset,
    matchProblems,
    matchToProblem,
    normalizePatterns,
    type ProblemMatchingPattern,
    resolveDiagnosticFilePath,
    sameProblem,
    severityRank,
} from '../../src/problemMatching';

// Fixtures stay in the source tree. Compiled tests run from out/tests/unit, three levels below.
const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function readFixture(...segments: string[]): string {
    return fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
}

const PROJECT_PATH = '/home/dev/probe';

suite('getPatternsPreset', () => {
    test('"gcc" returns the same three patterns as getGccPatternsPreset', () => {
        assert.deepStrictEqual(getPatternsPreset('gcc'), getGccPatternsPreset());
    });

    test('an unknown mode returns no patterns', () => {
        assert.deepStrictEqual(getPatternsPreset('nonsense'), []);
    });
});

suite('gcc preset against real compile-failure output', () => {
    for (const version of ['ceedling-1.0.0', 'ceedling-1.1.0']) {
        test(`${version}: finds the compiler error, with no duplicate or false match`, () => {
            const stderr = readFixture(version, 'compile-failure-stderr.txt');
            const problems = getGccPatternsPreset().flatMap((pattern) => getPatternProblems('', stderr, PROJECT_PATH, pattern));

            assert.strictEqual(problems.length, 1, 'expected exactly one match across all three patterns');
            const [problem] = problems;
            assert.strictEqual(problem.file, path.join(PROJECT_PATH, 'test/test_broken.c'));
            assert.strictEqual(problem.severity, 'error');
            assert.strictEqual(problem.startLine, 8); // line 9, 0-based
            assert.strictEqual(problem.startColumn, 0); // column 1, 0-based
            assert.match(problem.message, /expected .;. before .}. token/);
        });
    }
});

// Ceedling 1.2.2's hand-off notices name installations by path, which no compiler pattern may read
// as a diagnostic, though they come on stdout.
suite('gcc preset against Ceedling 1.2.2 hand-off notices', () => {
    test('finds nothing in them, even read as compiler output', () => {
        const stdout = readFixture('ceedling-1.2.2', 'files-test-handoff-stdout.txt');
        assert.deepStrictEqual(getGccPatternsPreset().flatMap((pattern) => getPatternProblems(stdout, stdout, PROJECT_PATH, pattern)), []);
    });
});

// A missing header is GCC's "fatal error", not "error". Ceedling 1.0.0 passes it through as is.
// Ceedling 1.2.0 instead reports its own exception, naming no file or line, before compiling.
suite('gcc preset against a real missing-header failure', () => {
    test('ceedling-1.0.0: finds the fatal error at its own file and line, once', () => {
        const stderr = readFixture('ceedling-1.0.0', 'compile-missing-header-stderr.txt');
        const problems = getGccPatternsPreset().flatMap((pattern) => getPatternProblems('', stderr, PROJECT_PATH, pattern));
        assert.strictEqual(problems.length, 1, 'expected exactly one match across all three patterns');
        const [problem] = problems;
        assert.strictEqual(problem.file, path.join(PROJECT_PATH, 'test/test_missing.c'));
        assert.strictEqual(problem.severity, 'error');
        assert.strictEqual(problem.startLine, 1);
        assert.strictEqual(problem.startColumn, 9);
        assert.strictEqual(problem.message, 'missing_header.h: No such file or directory');
    });
});

suite('gcc preset against real linker-failure output', () => {
    // The two toolchains' ld differ. 1.1.0's newer ld inserts a "(.text+0xNN):" section and offset
    // after the line number, 1.0.0's older one doesn't. The one catch-all pattern takes both.
    for (const version of ['ceedling-1.0.0', 'ceedling-1.1.0']) {
        test(`${version}: finds the linker's undefined-reference error, with no duplicate or false match`, () => {
            const stderr = readFixture(version, 'linker-failure-stderr.txt');
            const problems = getGccPatternsPreset().flatMap((pattern) => getPatternProblems('', stderr, PROJECT_PATH, pattern));

            assert.strictEqual(problems.length, 1, 'expected exactly one match across all three patterns');
            const [problem] = problems;
            // ld reports an absolute path, which the project-path prefix must not be joined onto.
            assert.ok(path.isAbsolute(problem.file), `expected an absolute file path, got '${problem.file}'`);
            assert.match(problem.file, /test_calculator\.c$/);
            assert.strictEqual(problem.severity, 'error');
            assert.strictEqual(problem.startLine, 20); // line 21, 0-based
            assert.match(problem.message, /undefined reference to `undefined_symbol_for_probe'/);
        });
    }

    // Without its optional "(.text+0xNN):" segment, the catch-all requires whitespace right after
    // the line number, which the newer ld's output lacks. This pins why the segment is there.
    test('the pre-fix catch-all pattern does not match the 1.1.0 linker line', () => {
        const preFixCatchAll: ProblemMatchingPattern = {
            ...getGccPatternsPreset()[2],
            regexp: '^(.*):(\\d+):\\s+(?!(warning:|error:|note:))(.*)$',
        };
        const stderr = readFixture('ceedling-1.1.0', 'linker-failure-stderr.txt');
        assert.deepStrictEqual(getPatternProblems('', stderr, PROJECT_PATH, preFixCatchAll), []);
    });
});

suite('resolveDiagnosticFilePath', () => {
    test('joins a relative matched file onto a non-empty prefix', () => {
        assert.strictEqual(resolveDiagnosticFilePath('test/test_foo.c', '/project'), path.join('/project', 'test/test_foo.c'));
    });

    test('uses an empty prefix as "the matched file is already absolute"', () => {
        assert.strictEqual(resolveDiagnosticFilePath('/abs/test_foo.c', ''), path.normalize('/abs/test_foo.c'));
    });

    // A compiler or linker may report an absolute path even where a prefix applies to relative ones.
    test('uses an already-absolute matched file as-is, even under a non-empty prefix', () => {
        assert.strictEqual(resolveDiagnosticFilePath('/abs/test_foo.c', '/project'), path.normalize('/abs/test_foo.c'));
    });
});

suite('matchToProblem', () => {
    function exec(regexp: string, line: string): RegExpExecArray {
        const matches = new RegExp(regexp).exec(line);
        assert.ok(matches, `expected '${regexp}' to match '${line}'`);
        return matches;
    }

    test('builds a 0-based problem from a real error-pattern match', () => {
        const matches = exec('^(.*):(\\d+):(\\d+):\\s+error:\\s+(.*)$', 'test/foo.c:9:1: error: expected \';\'');
        const problem = matchToProblem(matches, 1, 4, 'error', '/project', 2, null, 3, null);
        assert.deepStrictEqual(problem, {
            file: path.normalize('/project/test/foo.c'),
            message: "expected ';'",
            severity: 'error',
            startLine: 8,
            startColumn: 0,
            endLine: 8,
            endColumn: 999,
        });
    });

    test('rejects a match when a configured group index is out of bounds', () => {
        const matches = exec('^(.*):(\\d+):(.*)$', 'test/foo.c:9:whatever');
        assert.strictEqual(matchToProblem(matches, 1, 99, 'error', '', 2, null, null, null), undefined);
    });

    // An optional group that didn't participate is undefined, though its index is in range.
    test('rejects a match whose file group did not participate', () => {
        const matches = exec('^(?:(\\S+\\.c):)?(\\d+): (.*)$', '9: whatever');
        assert.strictEqual(matchToProblem(matches, 1, 3, 'error', '/project', 2, null, null, null), undefined);
    });

    test('a pattern with an optional file group still reports the lines where it matched', () => {
        const pattern: ProblemMatchingPattern = {
            scanStdout: false, scanStderr: true, severity: 'error', filePrefix: '/project',
            regexp: '^(?:(\\S+\\.c):)?(\\d+): (.*)$', message: 3, file: 1, line: 2, lastLine: null, column: null, lastColumn: null,
        };
        const problems = getPatternProblems('', '9: no file\nsrc/a.c:4: has file', '/project', pattern);
        assert.deepStrictEqual(problems.map((p) => [p.file, p.startLine]), [[path.join('/project', 'src/a.c'), 3]]);
    });

    test('rejects a match when a captured line value is not a number', () => {
        const matches = exec('^(.*):(\\w+):(.*)$', 'test/foo.c:NaN:whatever');
        assert.strictEqual(matchToProblem(matches, 1, 3, 'error', '', 2, null, null, null), undefined);
    });

    test('a configured last line and last column end the range', () => {
        const matches = exec('^(.*):(\\d+)-(\\d+):(\\d+)-(\\d+): (.*)$', 'src/a.c:3-5:2-7: spans');
        const problem = matchToProblem(matches, 1, 6, 'warning', '', 2, 3, 4, 5);
        assert.deepStrictEqual(problem && [problem.startLine, problem.startColumn, problem.endLine, problem.endColumn], [2, 1, 4, 6]);
    });

    // GCC 7 and earlier report `<command-line>:0:0:` for a redefined command-line macro.
    test('a line or column of 0 places the problem at the start, rather than before it', () => {
        const matches = exec('^(.*):(\\d+):(\\d+): (.*)$', '<command-line>:0:0: "FOO" redefined');
        const problem = matchToProblem(matches, 1, 4, 'warning', '', 2, null, 3, null);
        assert.deepStrictEqual(problem && [problem.startLine, problem.startColumn, problem.endLine], [0, 0, 0]);
    });

    test('a pattern without a line group places the problem at the top of the file', () => {
        const matches = exec('^(.*): (.*)$', 'src/a.c: somewhere');
        const problem = matchToProblem(matches, 1, 2, 'info', '', null, null, null, null);
        assert.deepStrictEqual(problem && [problem.startLine, problem.startColumn, problem.endLine, problem.endColumn], [0, 0, 0, 999]);
    });
});

suite('getPatternProblems', () => {
    const pattern = (scanStdout: boolean, scanStderr: boolean): ProblemMatchingPattern => ({
        scanStdout, scanStderr, severity: 'error', filePrefix: '${projectPath}',
        regexp: '^(\\S+\\.c):(\\d+): (.*)$', message: 3, file: 1, line: 2, lastLine: null, column: null, lastColumn: null,
    });

    test('scans only the streams the pattern names', () => {
        const files = (p: ProblemMatchingPattern) => getPatternProblems('out.c:1: from stdout', 'err.c:1: from stderr', '/project', p).map((m) => m.message);
        assert.deepStrictEqual(files(pattern(false, true)), ['from stderr']);
        assert.deepStrictEqual(files(pattern(true, false)), ['from stdout']);
        assert.deepStrictEqual(files(pattern(true, true)), ['from stdout', 'from stderr']);
    });

    test('${projectPath} in the file prefix becomes the project directory', () => {
        const [problem] = getPatternProblems('', 'src/a.c:1: here', '/project', pattern(false, true));
        assert.strictEqual(problem.file, path.join('/project', 'src/a.c'));
    });
});

suite('normalizePatterns', () => {
    test('defaults every optional field, and keeps a well-shaped pattern', () => {
        const { valid, invalid } = normalizePatterns([
            { regexp: '^(.*)$', message: 0, file: 0 },
        ]);
        assert.deepStrictEqual(invalid, []);
        assert.deepStrictEqual(valid, [{
            scanStdout: false,
            scanStderr: true,
            severity: 'info',
            filePrefix: '',
            regexp: '^(.*)$',
            message: 0,
            file: 0,
            line: null,
            lastLine: null,
            column: null,
            lastColumn: null,
        }]);
    });

    test('drops a pattern missing a required field', () => {
        const { valid, invalid } = normalizePatterns([
            { message: 0, file: 0 }, // no regexp
        ]);
        assert.deepStrictEqual(valid, []);
        assert.strictEqual(invalid.length, 1);
    });

    test('keeps each optional field that is configured, and falls back from an unknown severity', () => {
        const { valid } = normalizePatterns([
            { regexp: 'x', message: 1, file: 2, scanStdout: true, scanStderr: false, severity: 'warning', filePrefix: '/p', line: 3, lastLine: 4, column: 5, lastColumn: 6 },
            { regexp: 'x', message: 1, file: 2, severity: 'fatal' },
        ]);
        assert.deepStrictEqual(valid[0], {
            scanStdout: true, scanStderr: false, severity: 'warning', filePrefix: '/p',
            regexp: 'x', message: 1, file: 2, line: 3, lastLine: 4, column: 5, lastColumn: 6,
        });
        assert.strictEqual(valid[1]?.severity, 'info');
    });

    test('drops an entry that is not an object', () => {
        const { valid, invalid } = normalizePatterns([null, 'gcc', 3]);
        assert.deepStrictEqual(valid, []);
        assert.deepStrictEqual(invalid, [null, 'gcc', 3]);
    });

    test('drops a pattern whose required field is the wrong type', () => {
        const { valid, invalid } = normalizePatterns([
            { regexp: '^(.*)$', message: '0', file: 0 }, // message is a string
        ]);
        assert.deepStrictEqual(valid, []);
        assert.strictEqual(invalid.length, 1);
    });
});

suite('matchProblems', () => {
    const calls: Array<[string, string]> = [];
    const log = { debug: (message: unknown) => { calls.push(['debug', String(message)]); }, warn: (message: unknown) => { calls.push(['warn', String(message)]); } };
    const output = { stdout: '', stderr: 'test/test_calc.c:3:5: error: expected ‘;’\nsrc/calc.h:1:1: warning: unused\n' };

    test('"disabled" finds nothing, and "gcc" its preset\'s problems under the project', () => {
        assert.deepStrictEqual(matchProblems(output, '/ws', 'disabled', [], log, path.posix), []);
        const found = matchProblems(output, '/ws', 'gcc', [], log, path.posix);
        assert.deepStrictEqual(found.map((p) => [p.severity, p.file, p.startLine, p.message]).sort(),
            [['error', '/ws/test/test_calc.c', 2, 'expected ‘;’'], ['warning', '/ws/src/calc.h', 0, 'unused']]);
    });

    test("the user's patterns: a malformed one is dropped and a broken regexp skipped, sparing the rest", () => {
        calls.length = 0;
        const patterns = [{ regexp: '(' , file: 1, message: 2 }, { file: 1 }, { regexp: '^(.*):(\\d+):(\\d+): error: (.*)$', file: 1, line: 2, column: 3, message: 4, scanStderr: true }];
        const found = matchProblems(output, '/ws', 'patterns', patterns, log, path.posix);
        assert.deepStrictEqual(found.map((p) => p.message), ['expected ‘;’']);
        assert.ok(calls.some(([level, message]) => level === 'debug' && /dropping malformed pattern/.test(message)));
        assert.ok(calls.some(([level, message]) => level === 'warn' && /invalid regexp \(\(\)/.test(message)));
    });

    // The engine's platform decides, so a Windows project resolves as one wherever this runs.
    test('paths follow the given platform', () => {
        const found = matchProblems({ stdout: '', stderr: 'test\\test_calc.c:3:5: error: nope\n' }, 'C:\\ws', 'gcc', [], log, path.win32);
        assert.deepStrictEqual(found.map((p) => p.file), ['C:\\ws\\test\\test_calc.c']);
    });
});

suite('severityRank / sameProblem', () => {
    test('errors rank before warnings, and warnings before the rest', () => {
        assert.deepStrictEqual(['info', 'warning', 'error'].sort((a, b) => severityRank(a) - severityRank(b)), ['error', 'warning', 'info']);
    });

    test('problems are the same when every field is', () => {
        const problem = { file: '/a.c', message: 'm', severity: 'error', startLine: 1, startColumn: 2, endLine: 1, endColumn: 999 };
        assert.ok(sameProblem(problem, { ...problem }));
        assert.ok(!sameProblem(problem, { ...problem, startColumn: 3 }));
    });
});
