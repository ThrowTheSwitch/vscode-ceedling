// Coalesces overlapping requests for one piece of asynchronous work, such as rediscovering a
// workspace folder's tests. A request while the work runs schedules exactly one more run after
// it, however many requests arrive. Each caller's promise settles when a run that started after
// its request finishes. Startup, file watchers, and settings changes can all ask for discovery at
// once, and each discovery starts several Ceedling processes.
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
            let error: unknown;
            do {
                this.rerun = false;
                error = undefined;
                try {
                    await this.work();
                } catch (e) {
                    error = e;
                }
            } while (this.rerun);
            if (error !== undefined) {
                throw error;
            }
        } finally {
            this.flight = undefined;
        }
    }
}
