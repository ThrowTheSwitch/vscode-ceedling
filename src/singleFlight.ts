// Coalesces overlapping requests for one piece of asynchronous work, such as rediscovering a
// workspace folder's tests. A request while the work runs schedules exactly one more run after
// it, however many requests arrive. Each caller's promise settles when a run that started after
// its request finishes. Startup, file watchers, and settings changes can all ask for discovery at
// once, and each discovery starts several Ceedling processes.
type Outcome = { failed: false } | { failed: true, reason: unknown };

export class SingleFlight {
    private flight: Promise<void> | undefined;
    private rerun = false;

    constructor(private readonly work: () => Promise<void>) { }

    run(): Promise<void> {
        if (this.flight) {
            this.rerun = true;
        } else {
            this.flight = this.fly();
        }
        return this.flight;
    }

    // Repeats the work while requests keep arriving, then rejects with the last run's error, if any.
    private async fly(): Promise<void> {
        try {
            let outcome: Outcome;
            do {
                this.rerun = false;
                // eslint-disable-next-line no-await-in-loop -- each rerun must follow the run before it
                outcome = await this.attempt();
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- run() sets it during the await
            } while (this.rerun);
            if (outcome.failed) {
                throw outcome.reason;
            }
        } finally {
            this.flight = undefined;
        }
    }

    // A failure is recorded as a flag, so a rejection whose reason is itself undefined still counts.
    private async attempt(): Promise<Outcome> {
        try {
            await this.work();
            return { failed: false };
        } catch (reason) {
            return { failed: true, reason };
        }
    }
}
