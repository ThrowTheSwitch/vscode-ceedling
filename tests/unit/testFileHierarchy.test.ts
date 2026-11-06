import * as assert from 'assert';
import { filesInFolder, groupByFolder, TestFolder } from '../../src/testFileHierarchy';

// Depth-first, one line per folder id and per file, to compare a whole tree at a glance.
function flatten(folder: TestFolder<string>): string[] {
    return [...folder.files, ...folder.folders.flatMap((child) => [child.id, ...flatten(child)])];
}

const files = [
    'tests/unit/test_common.c',
    'tests/unit/math/arithmetic/test_abs_blackbox.c',
    'tests/unit/math/signal_processing/test_pi_blackbox.c',
    'tests/unit/math/arithmetic/test_abs_whitebox.c',
];

suite('groupByFolder', () => {
    test('nests each file under one folder per name in its path', () => {
        assert.deepStrictEqual(flatten(groupByFolder(files, (file) => file)), [
            'tests/',
            'tests/unit/',
            'tests/unit/test_common.c',
            'tests/unit/math/',
            'tests/unit/math/arithmetic/',
            'tests/unit/math/arithmetic/test_abs_blackbox.c',
            'tests/unit/math/arithmetic/test_abs_whitebox.c',
            'tests/unit/math/signal_processing/',
            'tests/unit/math/signal_processing/test_pi_blackbox.c',
        ]);
    });

    test('labels a folder with its own name only', () => {
        const root = groupByFolder(['test/LEDs/test_BlinkTask.c'], (file) => file);
        assert.strictEqual(root.folders[0].label, 'test');
        assert.strictEqual(root.folders[0].folders[0].label, 'LEDs');
    });

    test('keeps a file without a folder at the root', () => {
        const root = groupByFolder(['test_root.c'], (file) => file);
        assert.deepStrictEqual(root.files, ['test_root.c']);
        assert.deepStrictEqual(root.folders, []);
    });

    // path.relative() on Windows separates with '\'.
    test("accepts '\\' as a separator", () => {
        assert.deepStrictEqual(flatten(groupByFolder(['test\\LEDs\\test_BlinkTask.c'], (file) => file)), [
            'test/',
            'test/LEDs/',
            'test\\LEDs\\test_BlinkTask.c',
        ]);
    });
});

suite('filesInFolder', () => {
    test('collects the files of a folder and all its subfolders', () => {
        const math = groupByFolder(files, (file) => file).folders[0].folders[0].folders[0];
        assert.deepStrictEqual(filesInFolder(math), [
            'tests/unit/math/arithmetic/test_abs_blackbox.c',
            'tests/unit/math/arithmetic/test_abs_whitebox.c',
            'tests/unit/math/signal_processing/test_pi_blackbox.c',
        ]);
    });
});
