import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import * as xml2js from 'xml2js';
import {
    buildFileLabelRegex,
    buildTestLabelRegex,
    extractGdbLogReference,
    extractTestFunctionName,
    parseCeedlingVersionString,
    parseFileListBullets,
    testCaseFilterMatchedExactly,
} from '../../src/ceedlingOutputParsing';

// Fixtures stay in the source tree. Compiled tests run from out/tests/unit, three levels below.
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

    // Ceedling 1.1.0 bullets with "*" rather than 1.0.0's "-". Missing it lists no files at all.
    test('parses a Ceedling 1.1.0 "*" bulleted files:test transcript', () => {
        const stdout = readFixture('ceedling-1.1.0', 'files-test-stdout.txt');
        assert.deepStrictEqual(parseFileListBullets(stdout), [
            'test/test_calculator.c',
        ]);
    });

    // No captured Ceedling output uses "•". It is accepted defensively, so this input is synthetic.
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

    // A build's commit suffix is a semver prerelease identifier, so the version still compares.
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

suite('buildFileLabelRegex / buildTestLabelRegex', () => {
    test('buildFileLabelRegex captures the file name past a configured prefix', () => {
        const regex = buildFileLabelRegex('test_');
        const match = regex.exec('test/test_calculator.c');
        assert.ok(match);
        assert.strictEqual(match![1], 'calculator');
    });

    test('buildFileLabelRegex labels a file at the project root and one under backslashes', () => {
        const regex = buildFileLabelRegex('test_');
        assert.strictEqual(regex.exec('test_root.c')?.[1], 'root');
        assert.strictEqual(regex.exec('test\\unit\\test_win.c')?.[1], 'win');
    });

    test('buildFileLabelRegex takes only a literal .c extension, and a prefix starting the name', () => {
        const regex = buildFileLabelRegex('test_');
        assert.strictEqual(regex.exec('test/test_calcxc'), null);
        assert.strictEqual(regex.exec('test/my_test_calc.c'), null);
    });

    test('buildTestLabelRegex captures the function name past a configured prefix', () => {
        const regex = buildTestLabelRegex('test|spec|should');
        const match = regex.exec('test_add_should_ReturnSum');
        assert.ok(match);
        assert.strictEqual(match![1], 'add_should_ReturnSum');
    });
});

suite('extractTestFunctionName', () => {
    test('strips the file prefix and any parametrized-case arguments', () => {
        assert.strictEqual(
            extractTestFunctionName('test/test_calculator.c::test_add_should_ReturnSum'),
            'test_add_should_ReturnSum'
        );
        assert.strictEqual(
            extractTestFunctionName('test/test_calculator.c::test_add_ParameterizedCases(2, 3, 5)'),
            'test_add_ParameterizedCases'
        );
    });

    test('handles a bare function name with no file prefix', () => {
        assert.strictEqual(extractTestFunctionName('test_add_should_ReturnSum'), 'test_add_should_ReturnSum');
    });
});

suite('testCaseFilterMatchedExactly', () => {
    // Real names from tests/manual/test/test_calculator.c. Ceedling's substring filter
    // --test-case=test_add_should_ReturnSum also runs test_add_should_ReturnSumButIsDeliberatelyWrong.
    test('detects the real substring-collision case', () => {
        const reported = [
            'test/test_calculator.c::test_add_should_ReturnSum',
            'test/test_calculator.c::test_add_should_ReturnSumButIsDeliberatelyWrong',
        ];
        assert.strictEqual(testCaseFilterMatchedExactly('test_add_should_ReturnSum', reported), false);
    });

    test('allows multiple results for the same parametrized function', () => {
        const reported = [
            'test/test_param.c::test_add_ParameterizedCases(2, 3, 5)',
            'test/test_param.c::test_add_ParameterizedCases(10, -4, 6)',
        ];
        assert.strictEqual(testCaseFilterMatchedExactly('test_add_ParameterizedCases', reported), true);
    });

    test('allows a single, exactly-matching result', () => {
        assert.strictEqual(
            testCaseFilterMatchedExactly('test_add_should_ReturnSum', ['test/test_calculator.c::test_add_should_ReturnSum']),
            true
        );
    });
});

suite('extractGdbLogReference', () => {
    function parseXml(xmlText: string): Promise<any> {
        const parser = new xml2js.Parser({ explicitArray: false });
        return new Promise((resolve, reject) => {
            parser.parseString(xmlText, (error: any, result: any) => error ? reject(error) : resolve(result));
        });
    }

    // Captured from Ceedling 1.1.0 with :use_backtrace: :gdb, for a test dereferencing null.
    test('splits a real Ceedling 1.1.0 :use_backtrace: :gdb crash message', async () => {
        const xmlText = readFixture('ceedling-1.1.0', 'cppunit-report-crash.xml');
        const parsed = await parseXml(xmlText);
        const message = parsed.TestRun.FailedTests.Test.Message;

        const { text, logPath } = extractGdbLogReference(message);
        assert.strictEqual(logPath, 'build/logs/test/test_calculator/test_should_crash.gdb.log');
        assert.strictEqual(text, 'Test case crashed >> [SIGSEGV] Segmentation fault\n`*p = 42;`');
    });

    test('returns the message unchanged when there is no gdb log reference', () => {
        const message = 'Expected 1 Was 5';
        assert.deepStrictEqual(extractGdbLogReference(message), { text: message, logPath: undefined });
    });

    // Ceedling 1.0.0's :use_backtrace: :gdb embeds the gdb text in the message, with no log file.
    test('does not match a Ceedling 1.0.0-style embedded gdb transcript', () => {
        const message = 'Test case crashed >> Program received signal SIGSEGV, Segmentation fault.\n0x0 in testCrash () at test/test_calculator.c:13';
        assert.deepStrictEqual(extractGdbLogReference(message), { text: message, logPath: undefined });
    });
});
