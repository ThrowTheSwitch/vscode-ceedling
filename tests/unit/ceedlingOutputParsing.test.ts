import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildFileLabelRegex,
    buildTestLabelRegex,
    extractCeedlingException,
    extractGdbLogReference,
    extractTestFunctionName,
    parseCeedlingVersions,
    parseFileListBullets,
    testCaseFilterMatchedExactly,
} from '../../src/ceedlingOutputParsing';
import { parseCppUnitReport } from '../../src/testResults';

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

suite('parseCeedlingVersions', () => {
    test('reads a plain Ceedling 1.0.0 version as the one that runs the project', () => {
        const stdout = readFixture('ceedling-1.0.0', 'version-stdout.txt');
        assert.deepStrictEqual(parseCeedlingVersions(stdout), { application: '1.0.0' });
    });

    test("keeps a Ceedling 1.1.0 build's commit suffix", () => {
        const stdout = readFixture('ceedling-1.1.0', 'version-stdout.txt');
        assert.deepStrictEqual(parseCeedlingVersions(stdout), { application: '1.1.0-5bbbc8f' });
    });

    // A Ceedling in the project's vendor/ceedling is another installation, even a copy of the same
    // build, so Ceedling reports the launcher on the PATH and the application it runs apart.
    test('reads the launcher and the application of a project with a vendored copy of the same build', () => {
        const stdout = readFixture('ceedling-1.2.1', 'version-vendored-stdout.txt');
        assert.deepStrictEqual(parseCeedlingVersions(stdout), { launcher: '1.2.1-47d2c5e', application: '1.2.1-47d2c5e' });
    });

    // The application is Ceedling 1.2.0, but a 1.2.1 launcher reports its own release with the
    // application's commit (Ceedling#1365).
    test('reads the launcher and the application of a project with a vendored Ceedling 1.2.0, as Ceedling 1.2.1 reports them', () => {
        const stdout = readFixture('ceedling-1.2.1', 'version-vendored-1.2.0-stdout.txt');
        assert.deepStrictEqual(parseCeedlingVersions(stdout), { launcher: '1.2.1-47d2c5e', application: '1.2.1-13a540f' });
    });

    test('returns undefined when no Ceedling version line is present', () => {
        assert.strictEqual(parseCeedlingVersions('nothing relevant here\n'), undefined);
        assert.strictEqual(parseCeedlingVersions('  Ceedling Launcher => 1.2.1-47d2c5e\n'), undefined);
    });
});

suite('buildFileLabelRegex / buildTestLabelRegex', () => {
    test('buildFileLabelRegex captures the file name past a configured prefix', () => {
        const regex = buildFileLabelRegex('test_');
        const match = regex.exec('test/test_calculator.c');
        assert.ok(match);
        assert.strictEqual(match[1], 'calculator');
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
        assert.strictEqual(match[1], 'add_should_ReturnSum');
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

    // C identifiers can't contain `::`, but a case's arguments, such as a string, can.
    test("a `::` inside a case's arguments is not the file separator", () => {
        assert.strictEqual(extractTestFunctionName('test/t.c::test_s("a::b")'), 'test_s');
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
    // Captured from Ceedling 1.1.0 with :use_backtrace: :gdb, for a test dereferencing null.
    test('splits a real Ceedling 1.1.0 :use_backtrace: :gdb crash message', async () => {
        const xmlText = readFixture('ceedling-1.1.0', 'cppunit-report-crash.xml');
        const [crash] = (await parseCppUnitReport(xmlText)).failed;
        const message = crash.message;

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

suite('extractCeedlingException', () => {
    // Ceedling 1.2.1 with decorators prefixes the line with an emoji, which the message drops.
    test("reads a decorated Ceedling 1.2.1 ambiguous file reference, without its decoration or closing line", () => {
        const stderr = readFixture('ceedling-1.2.1', 'ambiguous-file-stderr.txt');
        assert.strictEqual(extractCeedlingException(stderr),
            "EXCEPTION: Ambiguous file reference 'test_calc.c' found. Include more trailing path to distinguish among: " +
            'test/test_calc.c, test/unit/test_calc.c, extra/integration/test_calc.c');
    });

    test("keeps the compiler output a compiler failure's exception carries, through its executed command", () => {
        const exception = extractCeedlingException(readFixture('ceedling-1.2.1', 'compile-failure-stderr.txt')) ?? '';
        const lines = exception.split('\n');
        assert.match(lines[0] ?? '', /^EXCEPTION: 'Default Test Compiler' \(gcc\) terminated with exit code \[1\]/);
        assert.ok(lines.some((line) => line.includes('error: expected ‘;’ before ‘}’ token')));
        assert.match(lines[lines.length - 1] ?? '', /^Executed Command: gcc /);
    });

    for (const [version, fixture] of [['1.0.0', 'compile-missing-header-stderr.txt'], ['1.0.0', 'linker-failure-stderr.txt'], ['1.1.0', 'linker-failure-stderr.txt']] as const) {
        test(`reads Ceedling ${version}'s undecorated ${fixture.replace('-stderr.txt', '')} exception`, () => {
            const stderr = readFixture(`ceedling-${version}`, fixture);
            const exception = extractCeedlingException(stderr);
            assert.strictEqual(exception, stderr.slice(0, stderr.indexOf('\nCeedling could not complete operations')));
        });
    }

    test('finds the exception after other output, with CRLF line ends', () => {
        assert.strictEqual(extractCeedlingException('Building...\r\nEXCEPTION: Found no file `test_x.c` in search paths.\r\nCeedling could not complete operations because of errors\r\n'),
            'EXCEPTION: Found no file `test_x.c` in search paths.');
    });

    test('runs to the end of the output, less trailing blank lines, without the closing line', () => {
        assert.strictEqual(extractCeedlingException('EXCEPTION: stopped\ndetail\n\n'), 'EXCEPTION: stopped\ndetail');
    });

    test('is undefined when Ceedling raised no exception', () => {
        assert.strictEqual(extractCeedlingException('Compiling test_x.c...\nNo EXCEPTION here: an ordinary line\n'), undefined);
    });
});
