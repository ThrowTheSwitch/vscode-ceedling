import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseCppUnitReport } from '../../src/testResults';
import { type DiscoveredTest, discoverTests, expandRubyRange, rubyFloatToString } from '../../src/unityTestDiscovery';

// Ceedling names every test with Unity's runner generator (auto/generate_test_runner.rb), and
// the Testing view can only show a result whose name matches a discovered item. These tests pin
// discoverTests to that generator's behavior. The golden suite compares against real reports.
// The rest isolate each rule, with expected values taken from real Ceedling or Ruby output.

const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');
const PARAMS_ON = { testPrefix: 'test|spec|should', useParamTests: true };

function readFixture(...segments: string[]): string {
    return fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
}

// The name each discovered test or case reports under: `name(args)` per case, else `name`.
function reportedNames(tests: DiscoveredTest[]): string[] {
    return tests.flatMap((t) => t.cases.length > 0 ? t.cases.map((c) => `${t.name}(${c.args})`) : [t.name]);
}

function namesIn(source: string, options = PARAMS_ON): string[] {
    return reportedNames(discoverTests(source, options).tests);
}

suite('discoverTests: golden parity with real Ceedling reports', () => {
    for (const version of ['ceedling-1.0.0', 'ceedling-1.1.10', 'ceedling-1.2.0']) {
        test(`${version}: test_unity_parity.c`, async () => {
            const report = await parseCppUnitReport(readFixture(version, 'cppunit-report-unity-parity.xml'));
            const expected = report.passed.map((t) => t.name.replace(/^test\/test_unity_parity\.c::/, ''));
            assert.deepStrictEqual(namesIn(readFixture('source', 'test_unity_parity.c')), expected);
        });
    }
});

// A test file saved on Windows usually has CRLF line endings, and Ceedling reads it as is.
suite('discoverTests: CRLF line endings', () => {
    test('CRLF source yields the same names and lines as LF source', () => {
        const lf = readFixture('source', 'test_unity_parity.c').replace(/\r\n/g, '\n');
        assert.deepStrictEqual(discoverTests(lf.replace(/\n/g, '\r\n'), PARAMS_ON), discoverTests(lf, PARAMS_ON));
    });
});

suite('discoverTests: test names', () => {
    test('a conventional signature yields its bare name', () => {
        assert.deepStrictEqual(namesIn('void test_a(void)\n{\n}\n'), ['test_a']);
    });

    test('every function in a file is found, in source order', () => {
        assert.deepStrictEqual(namesIn('void test_a(void)\n{\n}\n\nvoid test_b(void)\n{\n}\n'), ['test_a', 'test_b']);
    });

    test('whitespace before the parameter list is not part of the name (issue #14)', () => {
        assert.deepStrictEqual(namesIn('void test_a (void)\n{\n}\nvoid test_b\t(\n    void)\n{\n}\n'), ['test_a', 'test_b']);
    });

    test('a one-line body containing parentheses does not extend the name', () => {
        assert.deepStrictEqual(namesIn('void test_x(void) { f(g(1)); }\n'), ['test_x']);
    });

    test('each alternative of the configured prefix is recognized', () => {
        assert.deepStrictEqual(namesIn('void spec_a(void) {}\nvoid should_b(void) {}\nvoid helper(void) {}\n'), ['spec_a', 'should_b']);
    });

    test('a function not declared at the start of a line is not a test', () => {
        assert.deepStrictEqual(namesIn('static void test_hidden(void) {}\n'), []);
    });

    test('a prototype and its definition yield one test', () => {
        assert.deepStrictEqual(namesIn('void test_p(void);\n\nvoid test_p(void)\n{\n}\n'), ['test_p']);
    });
});

suite('discoverTests: comments', () => {
    test('a test inside a block comment is ignored', () => {
        assert.deepStrictEqual(namesIn('/*\nvoid test_gone(void)\n{\n}\n*/\nvoid test_kept(void) {}\n'), ['test_kept']);
    });

    test('a test after a line comment is ignored', () => {
        assert.deepStrictEqual(namesIn('// void test_gone(void) {}\nvoid test_kept(void) {}\n'), ['test_kept']);
    });

    test('a line comment that hides the start of a block comment does not swallow what follows', () => {
        assert.deepStrictEqual(namesIn('// hides /*\nvoid test_kept(void) {}\n'), ['test_kept']);
    });

    test('comment markers inside a string literal are not comments', () => {
        assert.deepStrictEqual(namesIn('TEST_CASE("//x")\nTEST_CASE("/*y*/")\nvoid test_s(const char* s) {}\n'),
            ['test_s("//x")', 'test_s("/*y*/")']);
    });
});

suite('discoverTests: TEST_CASE', () => {
    test('arguments are trimmed inside their parentheses', () => {
        assert.deepStrictEqual(namesIn('TEST_CASE( 2, 3, 5 )\nTEST_CASE(10, -4, 6)\nvoid test_p (int a, int b, int c) {}\n'),
            ['test_p(2, 3, 5)', 'test_p(10, -4, 6)']);
    });

    test('nested parentheses and statement punctuation in strings survive intact', () => {
        assert.deepStrictEqual(namesIn('TEST_CASE(f(1), "a;b{c}")\nvoid test_n(int a, const char* s) {}\n'),
            ['test_n(f(1), "a;b{c}")']);
    });

    test('with parametrized tests disabled, a marked function is one test under its bare name', () => {
        assert.deepStrictEqual(namesIn('TEST_CASE(1)\nTEST_CASE(2)\nvoid test_p(int a) {}\n', { ...PARAMS_ON, useParamTests: false }),
            ['test_p']);
    });
});

suite('discoverTests: TEST_RANGE', () => {
    test('an inclusive [start, end, step] range expands every value', () => {
        assert.deepStrictEqual(namesIn('TEST_RANGE([0, 2, 1])\nvoid test_r(int x) {}\n'), ['test_r(0)', 'test_r(1)', 'test_r(2)']);
    });

    test('an exclusive <start, end, step> range omits its end', () => {
        assert.deepStrictEqual(namesIn('TEST_RANGE(<0, 2, 1>)\nvoid test_r(int x) {}\n'), ['test_r(0)', 'test_r(1)']);
    });

    test('several ranges in one marker expand to their cartesian product', () => {
        assert.deepStrictEqual(namesIn('TEST_RANGE([0, 1, 1], [5, 6, 1])\nvoid test_r(int a, int b) {}\n'),
            ['test_r(0, 5)', 'test_r(0, 6)', 'test_r(1, 5)', 'test_r(1, 6)']);
    });

    test('TEST_CASE and TEST_RANGE markers on one function accumulate in order', () => {
        assert.deepStrictEqual(namesIn('TEST_CASE(9)\nTEST_RANGE([1, 2, 1])\nvoid test_m(int x) {}\n'),
            ['test_m(9)', 'test_m(1)', 'test_m(2)']);
    });

    test('a zero step yields no cases from that marker, and a warning', () => {
        const { tests, warnings } = discoverTests('TEST_RANGE([0, 2, 0])\nvoid test_z(int x) {}\n', PARAMS_ON);
        assert.deepStrictEqual(reportedNames(tests), ['test_z']);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /test_z/);
    });

    // Unity's generator fails on such a marker (`undefined method 'map' for nil`), so Ceedling
    // cannot build the test.
    test('a marker without a bracketed range yields no cases, and a warning', () => {
        const { tests, warnings } = discoverTests('TEST_RANGE(1, 2, 3)\nvoid test_r(int x) {}\n', PARAMS_ON);
        assert.deepStrictEqual(reportedNames(tests), ['test_r']);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /TEST_RANGE for test_r/);
    });
});

suite('discoverTests: TEST_MATRIX', () => {
    test('lists expand to their cartesian product, first list outermost', () => {
        assert.deepStrictEqual(namesIn('TEST_MATRIX([1, 2], [3, 4])\nvoid test_m(int a, int b) {}\n'),
            ['test_m(1, 3)', 'test_m(1, 4)', 'test_m(2, 3)', 'test_m(2, 4)']);
    });

    test('a single list expands to one case per element', () => {
        assert.deepStrictEqual(namesIn('TEST_MATRIX([a, b])\nvoid test_m(int x) {}\n'), ['test_m(a)', 'test_m(b)']);
    });

    test('string and character elements keep their quotes, commas inside them included', () => {
        assert.deepStrictEqual(namesIn(`TEST_MATRIX(["x,y", 'z'])\nvoid test_m(int x) {}\n`), ['test_m("x,y")', `test_m('z')`]);
    });

    // Unity's generator fails on such a marker, as it does on a TEST_RANGE without a range.
    test('a marker without lists yields no cases, and a warning', () => {
        const { tests, warnings } = discoverTests('TEST_MATRIX(1, 2)\nvoid test_m(int x) {}\n', PARAMS_ON);
        assert.deepStrictEqual(reportedNames(tests), ['test_m']);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /TEST_MATRIX for test_m/);
    });
});

suite('discoverTests: line numbers', () => {
    const source = readFixture('source', 'test_unity_parity.c');
    const lines = source.split('\n');
    const lineOf = (text: string) => lines.findIndex((l) => l.includes(text));
    const tests = discoverTests(source, PARAMS_ON).tests;
    const find = (name: string) => tests.find((t) => t.name === name)!;

    test("a function's line is the line naming it", () => {
        assert.strictEqual(find('test_AfterTrickyComment').line, lineOf('void test_AfterTrickyComment'));
        assert.strictEqual(find('test_CommentBetweenCases').line, lineOf('void test_CommentBetweenCases'));
    });

    test("each TEST_CASE's line is its own marker line, across blank and comment lines", () => {
        assert.deepStrictEqual(find('test_CommentBetweenCases').cases.map((c) => c.line), [lineOf('TEST_CASE(1)'), lineOf('TEST_CASE(2)')]);
    });

    test("every case expanded from one TEST_RANGE or TEST_MATRIX shares that marker's line", () => {
        assert.ok(find('test_TwoRangesProduct').cases.every((c) => c.line === lineOf('TEST_RANGE([0, 1, 1], [5, 6, 1])')));
        assert.ok(find('test_Matrix').cases.every((c) => c.line === lineOf('TEST_MATRIX([1, 2], [3, 4])')));
    });

    test('a duplicate declaration locates the first occurrence', () => {
        assert.strictEqual(find('test_Prototyped').line, lineOf('void test_Prototyped(void);'));
    });
});

// Expected strings are Ruby 3.1 and 3.3 output (Ceedling 1.0.0 and 1.2.0 images), identical in
// both: `Float#to_s`, and `Range.new(b, e, excl).step(s).to_a.map(&:to_s)`.
suite('rubyFloatToString', () => {
    const vectors: Array<[number, string]> = [
        [0, '0.0'], [-0, '-0.0'], [1, '1.0'], [0.5, '0.5'], [0.1, '0.1'], [0.30000000000000004, '0.30000000000000004'],
        [1e-4, '0.0001'], [9.5e-5, '9.5e-05'], [1e-5, '1.0e-05'], [-1e-5, '-1.0e-05'], [1.25e-7, '1.25e-07'],
        [1e14, '100000000000000.0'], [999999999999999.9, '999999999999999.9'], [1e15, '1.0e+15'],
        [1234567890123456, '1.234567890123456e+15'], [1e20, '1.0e+20'], [-2.5, '-2.5'], [100, '100.0'],
        [1 / 3, '0.3333333333333333'], [5e-324, '5.0e-324'], [1.7976931348623157e308, '1.7976931348623157e+308'],
    ];
    for (const [value, expected] of vectors) {
        test(`${value} -> ${expected}`, () => assert.strictEqual(rubyFloatToString(value), expected));
    }
});

suite('expandRubyRange', () => {
    const vectors: Array<[string, string, string, boolean, string[]]> = [
        ['0', '4', '1', false, ['0', '1', '2', '3', '4']],
        ['0', '4', '1', true, ['0', '1', '2', '3']],
        ['0', '3', '2', false, ['0', '2']],
        ['-2', '2', '1', false, ['-2', '-1', '0', '1', '2']],
        ['5', '5', '1', false, ['5']],
        ['5', '5', '1', true, []],
        ['5', '4', '1', false, []],
        ['0.0', '1.0', '0.5', false, ['0.0', '0.5', '1.0']],
        ['0', '0.7', '0.1', false, ['0.0', '0.1', '0.2', '0.30000000000000004', '0.4', '0.5', '0.6000000000000001', '0.7']],
        ['0', '0.7', '0.1', true, ['0.0', '0.1', '0.2', '0.30000000000000004', '0.4', '0.5', '0.6000000000000001']],
        ['0', '2.0', '1', false, ['0.0', '1.0', '2.0']],
        ['0', '1', '0.25', true, ['0.0', '0.25', '0.5', '0.75']],
        ['1.0', '0.0', '0.5', false, []],
        ['-1.5', '1.5', '0.5', false, ['-1.5', '-1.0', '-0.5', '0.0', '0.5', '1.0', '1.5']],
        ['0', '1', '0.3', false, ['0.0', '0.3', '0.6', '0.8999999999999999']],
        ['0', '0.9', '0.3', true, ['0.0', '0.3', '0.6', '0.8999999999999999']],
        ['0.1', '0.5', '0.1', false, ['0.1', '0.2', '0.30000000000000004', '0.4', '0.5']],
        ['2', '0', '-1', false, ['2', '1', '0']],
        ['2', '0', '-1', true, ['2', '1']],
        ['0', '2', '-1', false, []],
        ['1.0', '0.0', '-0.5', false, ['1.0', '0.5', '0.0']],
        ['1.0', '0.0', '-0.5', true, ['1.0', '0.5']],
        ['2', '0.0', '-1', false, ['2.0', '1.0', '0.0']],
        ['1.0', '0.0', '0.5', true, []],
        ['0.0', '0.5', '1.0', true, ['0.0']],
        ['5.0', '5.0', '1', true, []],
        ['0.0', '0.25', '0.1', true, ['0.0', '0.1', '0.2']],
    ];
    for (const [start, end, step, excludeEnd, expected] of vectors) {
        const range = `${excludeEnd ? '<' : '['}${start}, ${end}, ${step}${excludeEnd ? '>' : ']'}`;
        test(`${range} -> [${expected.join(', ')}]`, () => {
            assert.deepStrictEqual(expandRubyRange(start, end, step, excludeEnd), expected);
        });
    }

    // Ruby raises "step can't be 0", which fails Ceedling's runner generation outright.
    test('a zero step is rejected', () => {
        assert.strictEqual(expandRubyRange('0', '2', '0', false), undefined);
        assert.strictEqual(expandRubyRange('0', '2', '0.0', false), undefined);
    });
});
