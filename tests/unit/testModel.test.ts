import * as assert from 'assert';
import { controllerLabel } from '../../src/testModel';

suite('controllerLabel', () => {
    test('a single folder\'s tests are simply Ceedling', () => {
        assert.strictEqual(controllerLabel('firmware', 1), 'Ceedling');
    });

    test('with several folders, each folder\'s tests are named by the folder', () => {
        assert.strictEqual(controllerLabel('firmware', 2), 'Ceedling (firmware)');
    });
});
