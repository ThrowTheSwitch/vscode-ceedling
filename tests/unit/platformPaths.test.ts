import * as assert from 'assert';
import { pathKey, samePath, viaLink } from '../../src/platformPaths';

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
        assert.ok(!samePath('/ws/Vendor', '/ws/vendor', 'linux', '/'));
    });
});

// A coverage tool names sources from its working directory, which has its symlinks resolved, while
// the editor knows the project by the path it was opened at.
suite('viaLink', () => {
    test("on macOS, a path beneath /private/var returns beneath /var, the project's sources and those above it alike", () => {
        assert.strictEqual(viaLink('/private/var/f/x/proj/src/calc.c', '/var/f/x/proj', '/private/var/f/x/proj', 'darwin'), '/var/f/x/proj/src/calc.c');
        assert.strictEqual(viaLink('/private/var/f/x/lib/Clamp.c', '/var/f/x/proj', '/private/var/f/x/proj', 'darwin'), '/var/f/x/lib/Clamp.c');
        assert.strictEqual(viaLink('/private/var/f/x/proj', '/var/f/x/proj', '/private/var/f/x/proj', 'darwin'), '/var/f/x/proj');
    });

    test('a link to a differently named directory maps whatever lies beneath its target', () => {
        assert.strictEqual(viaLink('/Volumes/data/src/lib/a.c', '/Users/u/code/proj', '/Volumes/data/src/proj', 'darwin'), '/Users/u/code/lib/a.c');
    });

    test("on Windows, a subst drive's target maps back to the drive, whatever the case", () => {
        assert.strictEqual(viaLink('C:\\Long\\Path\\lib\\a.c', 'S:\\proj', 'C:\\long\\path\\Proj', 'win32'), 'S:\\lib\\a.c');
    });

    test('a path outside the link, a directory with no link, and a link from a filesystem root map nowhere', () => {
        assert.strictEqual(viaLink('/opt/sdk/inc/a.h', '/var/f/proj', '/private/var/f/proj', 'darwin'), undefined);
        assert.strictEqual(viaLink('/Volumes/data/srcs/a.c', '/Users/u/code/proj', '/Volumes/data/src/proj', 'darwin'), undefined);
        assert.strictEqual(viaLink('/ws/src/calc.c', '/ws', '/ws', 'linux'), undefined);
        assert.strictEqual(viaLink('C:\\WS\\src\\calc.c', 'C:\\WS', 'c:\\ws', 'win32'), undefined);
        assert.strictEqual(viaLink('/src/calc.c', '/a/proj', '/proj', 'linux'), undefined);
    });
});
