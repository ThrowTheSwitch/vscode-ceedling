// Concurrency control for asynchronous work: grouped mapping that keeps input order, a lock per
// key, a limit shared by every caller, and a record of work under way.

type Entry<T> = { item: T, index: number };
type Failure = { reason: unknown };

// Runs `work` for every item, concurrently across groups and one item at a time within a group.
// Results keep the items' order. At the first failure no new work starts, work already in flight
// finishes, and then the first failure rejects, so nothing keeps running after the caller moves
// on. Two Ceedling processes in one project directory, for example, could collide on its build
// files, while different directories can't.
export async function mapGrouped<T, R>(items: readonly T[], groupOf: (item: T) => string, work: (item: T) => Promise<R>): Promise<R[]> {
    const groups = new Map<string, Array<Entry<T>>>();
    items.forEach((item, index) => {
        const key = groupOf(item);
        groups.set(key, [...(groups.get(key) ?? []), { item, index }]);
    });
    const results = new Array<R>(items.length);
    const state: { failure?: Failure } = {};
    await Promise.all([...groups.values()].map(async (members) => {
        for (const entry of members) {
            if (state.failure) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop -- one item at a time within a group
            await run(entry, work, results, state);
        }
    }));
    if (state.failure) {
        throw state.failure.reason;
    }
    return results;
}

// One item's work, its result stored at its index, its failure recorded once, first wins.
async function run<T, R>(entry: Entry<T>, work: (item: T) => Promise<R>, results: R[], state: { failure?: Failure }): Promise<void> {
    try {
        results[entry.index] = await work(entry.item);
    } catch (reason) {
        state.failure ??= { reason };
    }
}

// Runs work one at a time per key, in arrival order per key, while different keys proceed
// independently. Each run waits for the work queued before it under its key, whether that
// succeeded or failed.
export class KeyedLock {
    // The settled-when-free promise for each busy key: the end of its queue.
    private readonly tails = new Map<string, Promise<void>>();

    // Keys with work queued or running. Idle keys hold no state.
    get size(): number {
        return this.tails.size;
    }

    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
        this.tails.set(key, tail);
        await previous;
        try {
            return await work();
        } finally {
            release();
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        }
    }

    // Runs work holding every key. Keys are taken one at a time in sorted order, whatever order the
    // caller names them, so two callers can never each hold a key the other waits for.
    runAll<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
        const [first, ...rest] = [...new Set(keys)].sort();
        return first === undefined ? work() : this.run(first, () => this.runAll(rest, work));
    }
}

// Runs at most `limit` pieces of work at once, across every caller, starting queued work in
// arrival order. A finishing piece hands its slot straight to the next one waiting.
export class Limiter {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly limit: number) { }

    async run<T>(work: () => Promise<T>): Promise<T> {
        if (this.active < this.limit) {
            this.active++;
        } else {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        try {
            return await work();
        } finally {
            const next = this.waiting.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
    }
}

// Work under way, for something that must wait it all out, e.g. a clobber offered mid-run, which
// would otherwise land between a run's builds.
export class ActivityTracker {
    private readonly active = new Set<Promise<unknown>>();

    get size(): number {
        return this.active.size;
    }

    // Records `work` until it ends, and hands it back. Its rejection stays the caller's.
    track<T>(work: Promise<T>): Promise<T> {
        this.active.add(work);
        work.finally(() => this.active.delete(work)).catch(() => { /* the caller sees the rejection */ });
        return work;
    }

    // Settles once all work tracked so far has ended, however it ended.
    async settled(): Promise<void> {
        await Promise.allSettled([...this.active]);
    }
}
