import * as assert from 'assert';
import { DiagnosticsStore } from '../../src/diagnosticsStore';

type D = { file: string, message: string };
const d = (file: string, message: string): D => ({ file, message });
const store = () => new DiagnosticsStore<D>((a, b) => a.message === b.message);
const view = (byFile: Map<string, D[]>) => Object.fromEntries([...byFile].map(([file, ds]) => [file, ds.map((x) => x.message)]));

suite('DiagnosticsStore', () => {
    test('shows every id\'s diagnostics, grouped by file', () => {
        const s = store();
        s.set('p', [d('/a.c', 'one'), d('/b.h', 'two')]);
        s.set('p::test/t.c', [d('/a.c', 'three')]);
        assert.deepStrictEqual(view(s.byFile()), { '/a.c': ['one', 'three'], '/b.h': ['two'] });
    });

    // A project run and a file run can both report the same compiler error.
    test('the same diagnostic under two ids shows once', () => {
        const s = store();
        s.set('p', [d('/a.c', 'same')]);
        s.set('p::test/t.c', [d('/a.c', 'same'), d('/a.c', 'other')]);
        assert.deepStrictEqual(view(s.byFile()), { '/a.c': ['same', 'other'] });
    });

    test('setting an id replaces only its own diagnostics', () => {
        const s = store();
        s.set('p', [d('/a.c', 'project')]);
        s.set('q', [d('/a.c', 'old')]);
        s.set('q', [d('/a.c', 'new')]);
        assert.deepStrictEqual(view(s.byFile()), { '/a.c': ['project', 'new'] });
    });

    test('retain filters one id, and reports whether there was anything to filter', () => {
        const s = store();
        s.set('p', [d('/a.c', 'keep'), d('/t.c', 'drop')]);
        assert.strictEqual(s.retain('p', (x) => x.file !== '/t.c'), true);
        assert.strictEqual(s.retain('missing', () => false), false);
        assert.deepStrictEqual(view(s.byFile()), { '/a.c': ['keep'] });
    });

    test('retainIds drops whole ids, e.g. a deleted test file\'s', () => {
        const s = store();
        s.set('p', [d('/a.c', 'p')]);
        s.set('p::gone.c', [d('/gone.c', 'gone')]);
        s.retainIds((id) => id !== 'p::gone.c');
        assert.deepStrictEqual(view(s.byFile()), { '/a.c': ['p'] });
    });

    test('clear drops everything', () => {
        const s = store();
        s.set('p', [d('/a.c', 'p')]);
        s.clear();
        assert.deepStrictEqual(view(s.byFile()), {});
    });
});
