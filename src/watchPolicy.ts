// What a settings change, a watched file's event, or an edit makes the controller do. It has no
// `vscode` dependency. The controller owns the watchers and listeners themselves.
import { DISCOVERY_SETTINGS } from './settings';

// `affects` says whether a ceedlingExplorer setting changed. Turning problem matching off clears
// its diagnostics at once rather than at the next run. `problemMatchingMode` is read only then.
export function settingsChangeEffects(affects: (setting: string) => boolean, problemMatchingMode: () => string): { clearDiagnostics: boolean, rediscoverFor: string[] } {
    return {
        clearDiagnostics: affects('problemMatching') && problemMatchingMode() === 'disabled',
        rediscoverFor: DISCOVERY_SETTINGS.filter(affects),
    };
}

export type SourceEvent = 'changed' | 'created' | 'deleted';

// A C source event in a project directory. A change reparses that file, if it is a discovered
// test file. A test file appearing or disappearing rediscovers, since only `ceedling files:test`
// knows the full list.
export function sourceEventEffect(event: SourceEvent, file: { isTestFile: () => boolean, mayBeTestFile: () => boolean }): 'reparse' | 'rediscover' | 'none' {
    switch (event) {
        case 'changed': return 'reparse';
        case 'created': return file.mayBeTestFile() ? 'rediscover' : 'none';
        case 'deleted': return file.isTestFile() ? 'rediscover' : 'none';
    }
}

// The watchers to dispose and to create, keyed by what each watches, so that exactly `wanted` is watched.
export function watcherChanges(current: Iterable<string>, wanted: ReadonlySet<string>): { stale: string[], added: string[] } {
    const existing = new Set(current);
    return { stale: [...existing].filter((key) => !wanted.has(key)), added: [...wanted].filter((key) => !existing.has(key)) };
}

export type Timers<Handle> = {
    setTimeout(action: () => void, ms: number): Handle,
    clearTimeout(handle: Handle | undefined): void,
};

// Runs the latest action scheduled for a key once `delayMs` pass without another, e.g. reparsing
// an edited file once typing pauses. Tests substitute `timers`.
export class Debouncer<Handle = NodeJS.Timeout> {
    private readonly pending = new Map<string, Handle>();

    constructor(private readonly delayMs: number, private readonly timers: Timers<Handle> = globalThis as unknown as Timers<Handle>) { }

    schedule(key: string, action: () => void): void {
        this.timers.clearTimeout(this.pending.get(key));
        this.pending.set(key, this.timers.setTimeout(() => {
            this.pending.delete(key);
            action();
        }, this.delayMs));
    }

    dispose(): void {
        this.pending.forEach((handle) => { this.timers.clearTimeout(handle); });
        this.pending.clear();
    }
}
