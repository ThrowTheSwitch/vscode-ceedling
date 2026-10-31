import * as assert from 'assert';
import { pathKey, samePath } from '../../src/platformPaths';

// Two spellings of one Windows directory must share a lock, or their builds could overlap.
suite('pathKey', () => {
    test('on Windows, spellings of one path differing only in case share a key', () => {
        assert.strictEqual(pathKey('C:\\Work\\FW', 'win32'), pathKey('c:\\work\\fw', 'win32'));
    });

    test('elsewhere, case distinguishes paths', () => {
        assert.notStrictEqual(pathKey('/work/FW', 'linux'), pathKey('/work/fw', 'linux'));
    });
});

suite('samePath', () => {
    test('resolves both paths against the base, then compares them as the platform does', () => {
        assert.ok(samePath('vendor/ceedling', './vendor//ceedling/', 'linux', '/ws'));
        assert.ok(samePath('C:\\WS\\Vendor', 'vendor', 'win32', 'c:\\ws'));
        assert.ok(!samePath('/ws/Vendor', '/ws/vendor', 'linux'));
    });
});
