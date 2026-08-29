import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import {
    buildFileLabelRegex,
    buildTestFunctionRegex,
    buildTestLabelRegex,
    expandParametrizedTestCases,
    joinMacroAliases,
    normalizeMultilineFunctionName,
    parseCeedlingVersionString,
    parseFileListBullets,
} from '../../src/ceedlingOutputParsing';

// __dirname at runtime is out/tests/unit (tsc mirrors the source tree under outDir); fixtures are
// plain data files tsc doesn't copy into out/, so walk back up to the repo root to find them.
const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function readFixture(...segments: string[]): string {
    return fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
}

suite('parseFileListBullets', () => {
    test('parses a Ceedling 1.0.0 "-" bulleted files:test transcript', () => {
        const stdout = readFixture('ceedling-1.0.0', 'files-test-stdout.txt');
        assert.deepStrictEqual(parseFileListBullets(stdout), [
            'test/test_calculator.c',
            'test/test_param.c',
        ]);
    });

    // This is the regression test for the confirmed bug: Ceedling 1.1.0 emits a "*" bullet
    // instead of "-", which the original regex (`/^\s*[-•]\s+(.*)$/`) didn't accept at all,
    // silently returning an empty file list for every 1.1.0 project.
    test('parses a Ceedling 1.1.0 "*" bulleted files:test transcript', () => {
        const stdout = readFixture('ceedling-1.1.0', 'files-test-stdout.txt');
        assert.deepStrictEqual(parseFileListBullets(stdout), [
            'test/test_calculator.c',
        ]);
    });

    // "•" was never actually observed against real Ceedling output during probing, but an
    // earlier version of this code assumed some release used it - kept as defensive coverage
    // with a small synthetic (non-fixture) input.
    test('still accepts a "•" bulleted line defensively', () => {
        const stdout = 'Test files:\n • test/test_defensive.c\nFile count: 1\n';
        assert.deepStrictEqual(parseFileListBullets(stdout), ['test/test_defensive.c']);
    });

    test('ignores non-bulleted lines (headers, footers, banners)', () => {
        const stdout = readFixture('ceedling-1.1.0', 'files-test-stdout.txt');
        const files = parseFileListBullets(stdout);
        assert.ok(!files.some((f) => f.includes('EXAMPLE PROJECT')));
        assert.ok(!files.some((f) => f.startsWith('File count')));
    });
});

suite('parseCeedlingVersionString', () => {
    test('parses a plain Ceedling 1.0.0 version string', () => {
        const stdout = readFixture('ceedling-1.0.0', 'version-stdout.txt');
        assert.strictEqual(parseCeedlingVersionString(stdout), '1.0.0');
    });

    // Regression coverage for the confirmed-safe behavior: 1.1.0 reports a dev-build git-hash
    // suffix, which is valid semver (a prerelease identifier) and must still compare correctly.
    test('parses a Ceedling 1.1.0 version string with a dev-build suffix', () => {
        const stdout = readFixture('ceedling-1.1.0', 'version-stdout.txt');
        const version = parseCeedlingVersionString(stdout);
        assert.strictEqual(version, '1.1.0-5bbbc8f');
        assert.strictEqual(semver.lt(version!, '1.0.0'), false);
    });

    test('returns undefined when no "Ceedling => x.y.z" line is present', () => {
        assert.strictEqual(parseCeedlingVersionString('nothing relevant here\n'), undefined);
    });
});

suite('joinMacroAliases', () => {
    test('joins configured TEST_CASE/TEST_RANGE aliases into one alternation', () => {
        assert.strictEqual(joinMacroAliases(['TEST_CASE', 'MY_CASE'], ['TEST_RANGE']), 'TEST_CASE|MY_CASE|TEST_RANGE');
    });
});

suite('buildTestFunctionRegex / expandParametrizedTestCases', () => {
    test('matches a real TEST_CASE-decorated function and expands its args', () => {
        const fileText = readFixture('source', 'test_param.c');
        const regex = buildTestFunctionRegex('test|spec|should', ['TEST_CASE'], ['TEST_RANGE']);
        const match = regex.exec(fileText);
        assert.ok(match, 'expected the function regex to match test_add_ParameterizedCases');
        assert.strictEqual(normalizeMultilineFunctionName(match![2]), 'test_add_ParameterizedCases');

        const cases = expandParametrizedTestCases(match![1], ['TEST_CASE'], ['TEST_RANGE']);
        assert.deepStrictEqual(cases.map((c) => c.args), ['2, 3, 5', '10, -4, 6']);
    });

    test('matches a real TEST_RANGE-decorated function and expands its range', () => {
        const fileText = readFixture('source', 'test_range_example.c');
        const regex = buildTestFunctionRegex('test|spec|should', ['TEST_CASE'], ['TEST_RANGE']);
        let match = regex.exec(fileText);
        assert.ok(match, 'expected a first function match (test_add_ParameterizedCases)');
        match = regex.exec(fileText);
        assert.ok(match, 'expected a second function match (test_add_RangeCases)');
        assert.strictEqual(normalizeMultilineFunctionName(match![2]), 'test_add_RangeCases');

        const cases = expandParametrizedTestCases(match![1], ['TEST_CASE'], ['TEST_RANGE']);
        assert.deepStrictEqual(cases.map((c) => c.args), ['0', '1', '2', '3', '4']);
    });

    test('returns an empty array for a non-parametrized function', () => {
        assert.deepStrictEqual(expandParametrizedTestCases('', ['TEST_CASE'], ['TEST_RANGE']), []);
    });
});

suite('normalizeMultilineFunctionName', () => {
    test('strips backslash-newline continuations', () => {
        assert.strictEqual(normalizeMultilineFunctionName('test_foo\\\n    _bar'), 'test_foo_bar');
    });

    test('leaves a single-line name unchanged', () => {
        assert.strictEqual(normalizeMultilineFunctionName('test_foo'), 'test_foo');
    });
});

suite('buildFileLabelRegex / buildTestLabelRegex', () => {
    test('buildFileLabelRegex captures the file name past a configured prefix', () => {
        const regex = buildFileLabelRegex('test_');
        const match = regex.exec('test/test_calculator.c');
        assert.ok(match);
        assert.strictEqual(match![1], 'calculator');
    });

    test('buildTestLabelRegex captures the function name past a configured prefix', () => {
        const regex = buildTestLabelRegex('test|spec|should');
        const match = regex.exec('test_add_should_ReturnSum');
        assert.ok(match);
        assert.strictEqual(match![1], 'add_should_ReturnSum');
    });
});
