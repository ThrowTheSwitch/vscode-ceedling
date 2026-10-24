import * as assert from 'assert';
import { KeyedLock, Limiter, mapGrouped } from '../../src/concurrency';

// Work items that finish when the test says, recording how many ran at once.
function gate() {
    const pending = new Map<string, () => void>();
    const log = { started: [] as string[], inFlight: 0, maxInFlight: 0 };
    const work = (item: string) => new Promise<string>((resolve, reject) => {
        log.started.push(item);
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        pending.set(item, () => {
            log.inFlight--;
            if (item.startsWith('fail')) reject(new Error(item)); else resolve(item.toUpperCase());
        });
    });
    const finish = async (item: string) => {
        pending.get(item)!();
        pending.delete(item);
        await new Promise((resolve) => setImmediate(resolve));
    };
    return { work, finish, log, pending };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

suite('mapGrouped', () => {
    const groupOf = (item: string) => item.charAt(0);

    test('runs different groups at once, and one item at a time within a group', async () => {
        const g = gate();
        const done = mapGrouped(['x1', 'y1', 'x2'], groupOf, g.work);
        await settle();
        assert.deepStrictEqual(g.log.started, ['x1', 'y1']);
        await g.finish('x1');
        assert.deepStrictEqual(g.log.started, ['x1', 'y1', 'x2']);
        await g.finish('x2');
        await g.finish('y1');
        assert.deepStrictEqual(await done, ['X1', 'Y1', 'X2']);
    });

    test('a failure stops its own and other groups from starting more, then rejects', async () => {
        const g = gate();
        const done = mapGrouped(['xfail', 'y1', 'x2', 'y2'], (item) => item.startsWith('x') ? 'x' : 'y', (item) => g.work(item === 'xfail' ? 'fail-x' : item));
        const rejected = assert.rejects(done, /fail-x/);
        await settle();
        await g.finish('fail-x');
        await g.finish('y1');
        await rejected;
        assert.deepStrictEqual(g.log.started, ['fail-x', 'y1']);
    });
});

suite('KeyedLock', () => {
    test('work under one key runs one at a time, in arrival order', async () => {
        const g = gate();
        const lock = new KeyedLock();
        const runs = ['k1', 'k2', 'k3'].map((item) => lock.run('dir', () => g.work(item)));
        await settle();
        assert.deepStrictEqual(g.log.started, ['k1']);
        await g.finish('k1');
        assert.deepStrictEqual(g.log.started, ['k1', 'k2']);
        await g.finish('k2');
        await g.finish('k3');
        assert.deepStrictEqual(await Promise.all(runs), ['K1', 'K2', 'K3']);
    });

    test('work under different keys runs at once', async () => {
        const g = gate();
        const lock = new KeyedLock();
        const runs = [lock.run('a', () => g.work('a1')), lock.run('b', () => g.work('b1'))];
        await settle();
        assert.deepStrictEqual(g.log.started, ['a1', 'b1']);
        await g.finish('a1');
        await g.finish('b1');
        await Promise.all(runs);
    });

    test('a failure releases the key for the next work, and reaches its own caller', async () => {
        const g = gate();
        const lock = new KeyedLock();
        const failing = assert.rejects(lock.run('dir', () => g.work('fail1')), /fail1/);
        const next = lock.run('dir', () => g.work('n1'));
        await settle();
        await g.finish('fail1');
        await failing;
        await g.finish('n1');
        assert.strictEqual(await next, 'N1');
    });

    test('an idle key holds no state', async () => {
        const lock = new KeyedLock();
        await lock.run('dir', async () => 1);
        assert.strictEqual(lock.size, 0);
    });

    test('work under several keys waits for each, then holds them all', async () => {
        const g = gate();
        const lock = new KeyedLock();
        const first = lock.run('x', () => g.work('x1'));
        const both = lock.runAll(['x', 'y'], () => g.work('xy1'));
        await settle();
        assert.deepStrictEqual(g.log.started, ['x1']);
        await g.finish('x1');
        assert.deepStrictEqual(g.log.started, ['x1', 'xy1']);
        const later = [lock.run('x', () => g.work('x2')), lock.run('y', () => g.work('y2'))];
        await settle();
        assert.deepStrictEqual(g.log.started, ['x1', 'xy1'], 'neither key is free while the work holding both runs');
        await g.finish('xy1');
        await g.finish('x2');
        await g.finish('y2');
        assert.deepStrictEqual(await Promise.all([first, both, ...later]), ['X1', 'XY1', 'X2', 'Y2']);
    });

    // Keys are taken in one order whatever order callers name them, so two callers never each hold
    // a key the other waits for.
    test('work naming the same keys in different orders, or one key twice, never deadlocks', async () => {
        const g = gate();
        const lock = new KeyedLock();
        const runs = [lock.runAll(['a', 'b'], () => g.work('ab')), lock.runAll(['b', 'a', 'b'], () => g.work('ba'))];
        await settle();
        await g.finish('ab');
        await g.finish('ba');
        assert.deepStrictEqual(await Promise.all(runs), ['AB', 'BA']);
        assert.strictEqual(await lock.runAll([], async () => 'none'), 'none');
        assert.strictEqual(lock.size, 0);
    });
});

suite('Limiter', () => {
    test('runs at most its limit at once, across every caller, starting queued work in arrival order', async () => {
        const g = gate();
        const limiter = new Limiter(2);
        const runs = ['a', 'b', 'c', 'd'].map((item) => limiter.run(() => g.work(item)));
        await settle();
        assert.deepStrictEqual(g.log.started, ['a', 'b']);
        await g.finish('b');
        assert.deepStrictEqual(g.log.started, ['a', 'b', 'c']);
        await g.finish('a');
        await g.finish('c');
        await g.finish('d');
        assert.deepStrictEqual(await Promise.all(runs), ['A', 'B', 'C', 'D']);
        assert.strictEqual(g.log.maxInFlight, 2);
    });

    test('a failure frees its slot and reaches its own caller', async () => {
        const g = gate();
        const limiter = new Limiter(1);
        const failing = assert.rejects(limiter.run(() => g.work('fail1')), /fail1/);
        const next = limiter.run(() => g.work('n1'));
        await settle();
        await g.finish('fail1');
        await failing;
        await g.finish('n1');
        assert.strictEqual(await next, 'N1');
    });
});
