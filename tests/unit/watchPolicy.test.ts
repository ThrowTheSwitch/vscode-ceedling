import * as assert from 'assert';
import { Debouncer, settingsChangeEffects, sourceEventEffect, watcherChanges } from '../../src/watchPolicy';

suite('settingsChangeEffects', () => {
    const affecting = (...settings: string[]) => (setting: string) => settings.includes(setting);

    // Discovery parses Ceedling's output too, so whether escape sequences are stripped from it counts.
    test('a setting that changes what discovery finds rediscovers, naming it', () => {
        for (const setting of ['projects', 'mixins', 'shellPath', 'ceedlingCommand', 'prettyTestLabel', 'prettyTestFileLabel', 'ansiEscapeSequencesRemoved']) {
            assert.deepStrictEqual(settingsChangeEffects(affecting(setting), () => 'gcc'), { clearDiagnostics: false, rediscoverFor: [setting] });
        }
    });

    // These apply on the next run, from the settings read then.
    test('a setting a run reads for itself changes nothing now', () => {
        assert.deepStrictEqual(settingsChangeEffects(affecting('testCommandArgs', 'coverageCommandArgs', 'coverageResetsCounters'), () => 'gcc'),
            { clearDiagnostics: false, rediscoverFor: [] });
    });

    test('turning problem matching off clears its diagnostics, without rediscovering', () => {
        assert.deepStrictEqual(settingsChangeEffects(affecting('problemMatching'), () => 'disabled'), { clearDiagnostics: true, rediscoverFor: [] });
        assert.deepStrictEqual(settingsChangeEffects(affecting('problemMatching'), () => 'gcc'), { clearDiagnostics: false, rediscoverFor: [] });
    });

    test('the problem matching mode is read only when problem matching changed', () => {
        let reads = 0;
        settingsChangeEffects(affecting('projects'), () => { reads++; return 'disabled'; });
        assert.strictEqual(reads, 0);
    });
});

suite('sourceEventEffect', () => {
    const file = (isTestFile: boolean, mayBeTestFile: boolean) => ({ isTestFile: () => isTestFile, mayBeTestFile: () => mayBeTestFile });

    test('a changed file is reparsed, which ignores anything not a discovered test file', () => {
        assert.strictEqual(sourceEventEffect('changed', file(true, true)), 'reparse');
        assert.strictEqual(sourceEventEffect('changed', file(false, false)), 'reparse');
    });

    // Only `ceedling files:test` knows the full list of test files.
    test('a new file that may be a test file rediscovers; any other new file does nothing', () => {
        assert.strictEqual(sourceEventEffect('created', file(false, true)), 'rediscover');
        assert.strictEqual(sourceEventEffect('created', file(false, false)), 'none');
    });

    test('a deleted test file rediscovers; any other deleted file does nothing', () => {
        assert.strictEqual(sourceEventEffect('deleted', file(true, true)), 'rediscover');
        assert.strictEqual(sourceEventEffect('deleted', file(false, true)), 'none');
    });
});

suite('watcherChanges', () => {
    test('watchers no longer wanted go, and newly wanted ones come, the rest untouched', () => {
        assert.deepStrictEqual(watcherChanges(['/a', '/b'], new Set(['/b', '/c'])), { stale: ['/a'], added: ['/c'] });
    });

    test('nothing changes when the wanted set is already watched', () => {
        assert.deepStrictEqual(watcherChanges(['/a'], new Set(['/a'])), { stale: [], added: [] });
    });
});

// A manual clock, so tests control when timers fire.
function manualTimers() {
    let now = 0;
    let nextId = 1;
    const pending = new Map<number, { at: number, action: () => void }>();
    return {
        timers: {
            setTimeout: (action: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, action }); return id; },
            clearTimeout: (id: number | undefined) => { if (id !== undefined) pending.delete(id); },
        },
        advance(ms: number) {
            now += ms;
            for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at <= now) { pending.delete(id); timer.action(); }
            }
        },
        get pending() { return pending.size; },
    };
}

suite('Debouncer', () => {
    test('runs the latest action for a key once its calls pause', () => {
        const clock = manualTimers();
        const debouncer = new Debouncer<number>(400, clock.timers);
        const ran: string[] = [];
        debouncer.schedule('a.c', () => ran.push('first'));
        clock.advance(300);
        debouncer.schedule('a.c', () => ran.push('second'));
        clock.advance(300);
        assert.deepStrictEqual(ran, []);
        clock.advance(100);
        assert.deepStrictEqual(ran, ['second']);
    });

    test('keys wait independently', () => {
        const clock = manualTimers();
        const debouncer = new Debouncer<number>(400, clock.timers);
        const ran: string[] = [];
        debouncer.schedule('a.c', () => ran.push('a'));
        clock.advance(200);
        debouncer.schedule('b.c', () => ran.push('b'));
        clock.advance(200);
        assert.deepStrictEqual(ran, ['a']);
        clock.advance(200);
        assert.deepStrictEqual(ran, ['a', 'b']);
    });

    test('dispose cancels everything pending', () => {
        const clock = manualTimers();
        const debouncer = new Debouncer<number>(400, clock.timers);
        const ran: string[] = [];
        debouncer.schedule('a.c', () => ran.push('a'));
        debouncer.schedule('b.c', () => ran.push('b'));
        debouncer.dispose();
        clock.advance(1000);
        assert.deepStrictEqual(ran, []);
        assert.strictEqual(clock.pending, 0);
    });
});
