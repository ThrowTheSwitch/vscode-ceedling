import * as assert from 'assert';
import { SingleFlight } from '../../src/singleFlight';

// Work that runs until the test releases it, counting how often it started.
function gatedWork() {
    const releases: Array<() => void> = [];
    const work = {
        starts: 0,
        run: () => new Promise<void>((resolve) => { work.starts++; releases.push(resolve); }),
        releaseNext: async () => {
            releases.shift()!();
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
    return work;
}

suite('SingleFlight', () => {
    test('a lone request runs the work once', async () => {
        const work = gatedWork();
        const flight = new SingleFlight(work.run);
        const done = flight.run();
        await work.releaseNext();
        await done;
        assert.strictEqual(work.starts, 1);
    });

    test('requests during a run coalesce into one rerun after it', async () => {
        const work = gatedWork();
        const flight = new SingleFlight(work.run);
        const first = flight.run();
        const second = flight.run();
        const third = flight.run();
        assert.strictEqual(work.starts, 1);
        await work.releaseNext();
        assert.strictEqual(work.starts, 2);
        await work.releaseNext();
        await Promise.all([first, second, third]);
        assert.strictEqual(work.starts, 2);
    });

    test('every caller resolves only after the run that covers its request', async () => {
        const work = gatedWork();
        const flight = new SingleFlight(work.run);
        void flight.run();
        let lateDone = false;
        void flight.run().then(() => { lateDone = true; });
        await work.releaseNext();
        assert.strictEqual(lateDone, false);
        await work.releaseNext();
        assert.strictEqual(lateDone, true);
    });

    // A rejection may carry any reason, undefined included, and must still reach the caller.
    test('a run rejecting with undefined still rejects its callers', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
        const flight = new SingleFlight(() => Promise.reject(undefined));
        let rejected = false;
        await flight.run().catch(() => { rejected = true; });
        assert.strictEqual(rejected, true);
    });

    test('a failed run rejects its callers, and the next request runs again', async () => {
        let calls = 0;
        const flight = new SingleFlight(async () => {
            calls++;
            if (calls === 1) throw new Error('boom');
        });
        await assert.rejects(flight.run(), /boom/);
        await flight.run();
        assert.strictEqual(calls, 2);
    });
});
