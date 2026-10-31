import * as assert from 'assert';
import { chooseExecutable, ownOrUnclaimed, testBuildLayout, testBuildName, testExecutableName } from '../../src/buildLayout';
import type { CeedlingFileNode } from '../../src/testModel';
import { capabilitiesOf } from '../../src/ceedlingVersions';

suite('testBuildLayout', () => {
    test('each release builds its tests in the layout it introduced, or the one before', () => {
        assert.deepStrictEqual(['1.1.10', '1.2.0', '1.2.1', '1.2.2'].map((v) => testBuildLayout(capabilitiesOf(v))), ['flat', 'testRoot', 'testRoot', 'projectPath']);
    });
});

// Ceedling names a test's build for its file's directory within the longest test path holding it:
// PathMirror.relative_subdir in 1.2.0 and 1.2.1, over :paths: :test: stripped of decorators and globs.
suite('testBuildName', () => {
    const named = (id: string, layout: 'flat' | 'testRoot' | 'projectPath', testPaths: string[] = ['+:test/**']) =>
        testBuildName(id, layout, { testPaths, projectDir: '/ws', platform: 'linux' });
    const nested = (id: string, paths: string[]) => named(id, 'testRoot', paths);
    const fromRoot = (id: string) => named(id, 'projectPath');

    test('before Ceedling 1.2.0, a test builds under its bare name', () => {
        assert.strictEqual(named('test/unit/test_calc.c', 'flat'), 'test_calc');
    });

    test("from 1.2.0, a test builds under its directory within its test path, or its bare name at that path's root", () => {
        assert.strictEqual(nested('test/unit/test_calc.c', ['+:test/**']), 'unit/test_calc');
        assert.strictEqual(nested('test/test_calc.c', ['+:test/**']), 'test_calc');
        assert.strictEqual(nested('test/a/b/test_calc.cpp', ['test/**']), 'a/b/test_calc');
    });

    test('the longest test path holding the file decides, so the same files may build in either layout', () => {
        assert.strictEqual(nested('test/unit/test_calc.c', ['+:test/**', '+:test/unit/**']), 'test_calc');
        const files = ['test/unit/test_calc.c', 'extra/unit/test_calc.c'];
        assert.deepStrictEqual(files.map((f) => nested(f, ['+:test/unit/**', '+:extra/**'])), ['test_calc', 'unit/test_calc']);
        assert.deepStrictEqual(files.map((f) => nested(f, ['+:test/**', '+:extra/unit/**'])), ['unit/test_calc', 'test_calc']);
    });

    test('a test path is cut back to the directory before its first glob, and a subtractive one counts as well', () => {
        assert.strictEqual(nested('test/x/unit/test_calc.c', ['test/*/unit']), 'x/unit/test_calc');
        assert.strictEqual(nested('test/unit/test_calc.c', ['test/unit/']), 'test_calc');
        assert.strictEqual(nested('test/unit/test_calc.c', ['  +: test  ']), 'unit/test_calc');
        assert.strictEqual(nested('test/support/x/test_calc.c', ['+:test/**', '-:test/support']), 'x/test_calc');
    });

    test('a file under no usable test path builds under its bare name', () => {
        assert.strictEqual(nested('other/unit/test_calc.c', ['+:test/**']), 'test_calc');
        assert.strictEqual(nested('test/unit/test_calc.c', ['**/unit']), 'test_calc');
        assert.strictEqual(nested('test_calc.c', ['+:test/**']), 'test_calc');
    });

    // Ceedling cuts `/*` to the root directory `/`, which then holds nothing, as `//` starts no path.
    test('absolute test paths place absolute test files, and the filesystem root holds none', () => {
        assert.strictEqual(nested('/abs/test/unit/test_calc.c', ['+:/abs/test/**']), 'unit/test_calc');
        assert.strictEqual(nested('/unit/test_calc.c', ['/*']), 'test_calc');
    });

    test('backslashes in paths and ids read as separators, as Ceedling standardizes them', () => {
        assert.strictEqual(nested('test\\unit\\test_calc.c', ['+:test\\**']), 'unit/test_calc');
    });

    // From 1.2.2, Ceedling's BuildSubpath.encode names a test by its path from the project root.
    test('from 1.2.2, a test builds under its path from the project root, whatever its test path', () => {
        assert.strictEqual(fromRoot('test/unit/test_calc.c'), 'test/unit/test_calc');
        assert.strictEqual(fromRoot('test/test_calc.c'), 'test/test_calc');
        assert.strictEqual(fromRoot('test_calc.c'), 'test_calc');
        assert.strictEqual(named('test/unit/test_calc.c', 'projectPath', ['+:test/unit/**']), 'test/unit/test_calc');
    });

    test('from 1.2.2, a path is normalized, and only its last extension goes', () => {
        assert.strictEqual(fromRoot('./test/./unit//test_calc.c'), 'test/unit/test_calc');
        assert.strictEqual(fromRoot('test/../other/test_x.c'), 'other/test_x');
        assert.strictEqual(fromRoot('test/unit/test.calc.c'), 'test/unit/test.calc');
        assert.strictEqual(fromRoot('test/Unit/Test_Calc.C'), 'test/Unit/Test_Calc');
        assert.strictEqual(fromRoot('/ws/test/test_x.c'), 'test/test_x');
    });

    // Ceedling reads a backslash as a separator everywhere, and Ruby's File.extname leaves a dotfile whole.
    test('from 1.2.2, backslashes separate on any platform, and a dotfile keeps its name', () => {
        assert.strictEqual(fromRoot('test\\..\\x\\test_x.c'), 'x/test_x');
        assert.strictEqual(fromRoot('test/.c'), 'test/.c');
    });

    test('from 1.2.2, a path outside the project climbs with _up_', () => {
        assert.strictEqual(fromRoot('../tests/unit/test_x.c'), '_up_/tests/unit/test_x');
        assert.strictEqual(fromRoot('/elsewhere/test_x.c'), '_up_/elsewhere/test_x');
    });

    // A folder already named like a marker gains a leading `_`, in any case, so names stay apart.
    test('from 1.2.2, a folder named like a marker gains a leading underscore', () => {
        assert.strictEqual(fromRoot('test/_up_/test_x.c'), 'test/__up_/test_x');
        assert.strictEqual(fromRoot('test/__Abs_/test_x.c'), 'test/___Abs_/test_x');
        assert.strictEqual(fromRoot('_unc_/_ceedling_/test_x.c'), '__unc_/__ceedling_/test_x');
        assert.strictEqual(fromRoot('test/up_/_up/test_x.c'), 'test/up_/_up/test_x');
    });

    test('from 1.2.2 on Windows, another drive goes under _abs_ and a share under _unc_', () => {
        const windows = (id: string) => testBuildName(id, 'projectPath', { testPaths: [], projectDir: 'C:\\ws', platform: 'win32' });
        assert.strictEqual(windows('test\\unit\\test_calc.c'), 'test/unit/test_calc');
        assert.strictEqual(windows('c:\\ws\\test\\test_x.c'), 'test/test_x');
        assert.strictEqual(windows('D:\\sdk\\test_x.c'), '_abs_/D/sdk/test_x');
        assert.strictEqual(windows('d:/sdk/_up_/test_x.c'), '_abs_/D/sdk/__up_/test_x');
        assert.strictEqual(windows('\\\\server\\share\\t\\test_x.c'), '_unc_/server/share/t/test_x');
        assert.strictEqual(windows('..\\tests\\test_x.c'), '_up_/tests/test_x');
        assert.strictEqual(windows('C:\\other\\test_x.c'), '_up_/other/test_x');
        assert.strictEqual(testBuildName('C:\\WS\\test\\test_x.c', 'projectPath', { testPaths: [], projectDir: 'c:\\ws', platform: 'win32' }), 'test/test_x');
        assert.strictEqual(windows('\\\\_up_\\share\\test_x.c'), '_unc_/__up_/share/test_x');
    });
});

suite('testExecutableName', () => {
    test("is the test file's base name with the executable's extension, as Ceedling forms it", () => {
        assert.strictEqual(testExecutableName('test/unit/test_calc.c', '.out'), 'test_calc.out');
        assert.strictEqual(testExecutableName('test\\unit\\test_calc.c', '.exe'), 'test_calc.exe');
        assert.strictEqual(testExecutableName('test/test.calc.c', '.out'), 'test.calc.out');
    });

    // Only the build directory escapes a marker. Ruby's File.extname leaves a dotfile whole.
    test('keeps a marker-named file\'s name, and a dotfile\'s', () => {
        assert.strictEqual(testExecutableName('test/_up_.c', '.out'), '_up_.out');
        assert.strictEqual(testExecutableName('test/.c', '.out'), '.c.out');
    });
});

suite('chooseExecutable', () => {
    test('the candidate the build wrote wins, even over a newer one it left alone', () => {
        assert.deepStrictEqual(chooseExecutable([1, 5], [2, 5]), { chosen: 0, found: true });
        assert.deepStrictEqual(chooseExecutable([undefined, 5], [undefined, 6]), { chosen: 1, found: true });
    });

    // A delta build may relink nothing.
    test('with nothing written, the newest that exists wins, else the release\'s own', () => {
        assert.deepStrictEqual(chooseExecutable([3, 7], [3, 7]), { chosen: 1, found: true });
        assert.deepStrictEqual(chooseExecutable([undefined, undefined], [undefined, undefined]), { chosen: 0, found: false });
    });
});

suite('ownOrUnclaimed', () => {
    const file = (id: string) => ({ id }) as CeedlingFileNode;
    const place = (f: CeedlingFileNode, layout = 'testRoot') => `${layout}:${f.id.replace(/^.*\//, '')}`;

    test('a known release looks in its own place alone', () => {
        assert.deepStrictEqual(ownOrUnclaimed(file('test/a.c'), [], place, true), ['testRoot:a.c']);
    });

    test("otherwise every layout's place counts, own first, but none another file claims", () => {
        const namesake = (f: CeedlingFileNode, layout = 'testRoot') => layout === 'flat' ? 'flat:shared' : place(f, layout);
        assert.deepStrictEqual(ownOrUnclaimed(file('test/a.c'), [file('test/a.c')], place, false), ['testRoot:a.c', 'projectPath:a.c', 'flat:a.c']);
        assert.deepStrictEqual(ownOrUnclaimed(file('test/a.c'), [file('test/a.c'), file('test/b.c')], namesake, false), ['testRoot:a.c', 'projectPath:a.c']);
    });
});
