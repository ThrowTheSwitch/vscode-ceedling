import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    getGccPatternsPreset,
    getPatternProblems,
    getPatternsPreset,
    matchToProblem,
    normalizePatterns,
    type ProblemMatchingPattern,
    resolveDiagnosticFilePath,
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

    test('drops a pattern whose required field is the wrong type', () => {
        const { valid, invalid } = normalizePatterns([
            { regexp: '^(.*)$', message: '0', file: 0 }, // message is a string
        ]);
        assert.deepStrictEqual(valid, []);
        assert.strictEqual(invalid.length, 1);
    });
});
