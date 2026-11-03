import * as assert from 'assert';
import { controllerLabel, coverageProfileLabel } from '../../src/testModel';

suite('controllerLabel', () => {
    test('a single folder\'s tests are simply Ceedling', () => {
        assert.strictEqual(controllerLabel('firmware', 1), 'Ceedling');
    });

    test('with several folders, each folder\'s tests are named by the folder', () => {
        assert.strictEqual(controllerLabel('firmware', 2), 'Ceedling (firmware)');
    });
});

suite('coverageProfileLabel', () => {
    test("a folder offering one coverage plugin offers plain Coverage", () => {
        assert.strictEqual(coverageProfileLabel('gcov', ['gcov']), 'Coverage');
        assert.strictEqual(coverageProfileLabel('bullseye', ['bullseye']), 'Coverage');
    });

    test('a folder offering both names each profile by its plugin', () => {
        assert.deepStrictEqual(['gcov', 'bullseye'].map((plugin) => coverageProfileLabel(plugin as 'gcov' | 'bullseye', ['gcov', 'bullseye'])),
            ['Coverage (gcov)', 'Coverage (Bullseye)']);
    });
});
