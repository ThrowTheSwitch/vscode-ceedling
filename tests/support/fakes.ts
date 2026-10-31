// Stand-ins the unit and validation tests share for what the engine takes from VS Code: a
// cancellation token, the log, and the settings.
import type { Cancellation } from '../../src/ceedlingProcess';
import type { Log } from '../../src/log';
import type { SettingsSource } from '../../src/settings';

// A cancellation that fires when the test says. `listeners` counts those still subscribed.
export function cancellation(): Cancellation & { fire(): void, readonly listeners: number } {
    const listeners = new Set<() => void>();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        fire() {
            token.isCancellationRequested = true;
            for (const listener of [...listeners]) listener();
        },
        get listeners() { return listeners.size; },
    };
    return token;
}

// A Log handing each call to `record`, its arguments joined as the message.
export function recordingLog(record: (level: string, message: string) => void): Log {
    const at = (level: string) => (...args: unknown[]) => { record(level, args.map(String).join(' ')); };
    return {
        trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
        showWarning: at('showWarning'), showError: at('showError'),
    };
}

// Settings read from `settings` as it stands at each read, else the default the code asks with.
export function settingsFrom(settings: Record<string, unknown>): SettingsSource {
    return { get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback) };
}
