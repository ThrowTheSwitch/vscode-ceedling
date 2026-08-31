import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    getGccPatternsPreset,
    getPatternProblems,
    getPatternsPreset,
    matchToProblem,
    normalizePatterns,
    ProblemMatchingPattern,
    resolveDiagnosticFilePath,
} from '../../src/problemMatching';

// __dirname at runtime is out/tests/unit (tsc mirrors the source tree under outDir); fixtures are
// plain data files tsc doesn't copy into out/, so walk back up to the repo root to find them.
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
            const stderr = readFixture(version, 'compile-failure-stdout.txt');
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

suite('gcc preset against real linker-failure output', () => {
    // Real ld output differs between the two probed toolchains: 1.1.0's newer ld inserts a
    // "(.text+0xNN):" section+offset between the line number and the message; 1.0.0's older ld
    // does not. Both must be recognized by the same catch-all pattern.
    for (const version of ['ceedling-1.0.0', 'ceedling-1.1.0']) {
        test(`${version}: finds the linker's undefined-reference error, with no duplicate or false match`, () => {
            const stderr = readFixture(version, 'linker-failure-stderr.txt');
            const problems = getGccPatternsPreset().flatMap((pattern) => getPatternProblems('', stderr, PROJECT_PATH, pattern));

            assert.strictEqual(problems.length, 1, 'expected exactly one match across all three patterns');
            const [problem] = problems;
            // The real ld output reports an absolute path - confirms resolveDiagnosticFilePath's
            // already-absolute handling, exercised here through the real preset, not just in
            // isolation below.
            assert.ok(path.isAbsolute(problem.file), `expected an absolute file path, got '${problem.file}'`);
            assert.match(problem.file, /test_calculator\.c$/);
            assert.strictEqual(problem.severity, 'error');
            assert.strictEqual(problem.startLine, 20); // line 21, 0-based
            assert.match(problem.message, /undefined reference to `undefined_symbol_for_probe'/);
        });
    }

    // Regression coverage for the confirmed bug this session's catch-all fix closes: the original
    // pattern (its optional "(.text+0xNN):" segment not yet added) required whitespace
    // immediately after the line number, which the newer ld's output does not have.
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

    // The fix this session added: an already-absolute matched file is used as-is even under a
    // non-empty prefix, instead of being nonsensically joined onto it.
    test('uses an already-absolute matched file as-is, even under a non-empty prefix', () => {
        assert.strictEqual(resolveDiagnosticFilePath('/abs/test_foo.c', '/project'), path.normalize('/abs/test_foo.c'));
    });
});

suite('matchToProblem', () => {
    function exec(regexp: string, line: string): RegExpExecArray {
        const matches = new RegExp(regexp).exec(line);
        assert.ok(matches, `expected '${regexp}' to match '${line}'`);
        return matches!;
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

    test('rejects a match when a captured line value is not a number', () => {
        const matches = exec('^(.*):(\\w+):(.*)$', 'test/foo.c:NaN:whatever');
        assert.strictEqual(matchToProblem(matches, 1, 3, 'error', '', 2, null, null, null), undefined);
    });
});

suite('normalizePatterns', () => {
    test('defaults every optional field, and keeps a well-shaped pattern', () => {
        const { valid, invalid } = normalizePatterns([
            { regexp: '^(.*)$', message: 0, file: 0 } as unknown as ProblemMatchingPattern,
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
            { message: 0, file: 0 } as unknown as ProblemMatchingPattern, // no regexp
        ]);
        assert.deepStrictEqual(valid, []);
        assert.strictEqual(invalid.length, 1);
    });

    test('drops a pattern whose required field is the wrong type', () => {
        const { valid, invalid } = normalizePatterns([
            { regexp: '^(.*)$', message: '0', file: 0 } as unknown as ProblemMatchingPattern, // message is a string
        ]);
        assert.deepStrictEqual(valid, []);
        assert.strictEqual(invalid.length, 1);
    });
});
