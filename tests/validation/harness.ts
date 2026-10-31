// What the validation suites share. Each suite drives the compiled CeedlingEngine against a real
// Ceedling release inside a vscode-ceedling-validate image (see run.sh), with VS Code's side of the
// engine stubbed: settings, the logger, and the Problems panel. A suite builds its projects in /ws,
// inside the container, from fixtures in the read-only repo, then exits 0 only when every check held.
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CeedlingEngine, type LayoutUpgrade } from '../../src/ceedlingEngine';
import { parseCeedlingVersions } from '../../src/ceedlingOutputParsing';
import { applicationRelease, capabilitiesOf, type CeedlingCapabilities, type CeedlingFeature } from '../../src/ceedlingVersions';
import { ceedlingEnvironment } from '../../src/ceedlingProcess';
import type { CeedlingFileNode, CeedlingProjectNode, CoverageOutcome, RunReporter } from '../../src/testModel';
import { cancellation, recordingLog, settingsFrom } from '../support/fakes';

export const WS = '/ws';
// Compiled suites live in out-test/tests/validation.
const REPO = path.resolve(__dirname, '../../..');

// `at` is when the engine logged it, in Date.now() milliseconds.
type LogCall = { level: string, message: string, at: number };

// An engine for the workspace at /ws. `settings` stays live: a suite changes a setting by
// assigning to it, as a user editing settings.json would.
// `upgrades` collects each clobber the engine offers after Ceedling moves a build's layout.
export function makeEngine(settings: Record<string, unknown>): { engine: CeedlingEngine, logs: LogCall[], upgrades: LayoutUpgrade[] } {
    const logs: LogCall[] = [];
    const upgrades: LayoutUpgrade[] = [];
    const logger = recordingLog((level, message) => { logs.push({ level, message, at: Date.now() }); });
    const engine = new CeedlingEngine(
        WS,
        logger,
        false,
        {
            settings: () => settingsFrom(settings),
            diagnostics: { set() { }, retain() { }, retainIds() { } },
            bundledMixinPath: path.join(REPO, 'assets/mixins/report-tests-log-factory.yml'),
            onLayoutUpgrade: (upgrade) => upgrades.push(upgrade),
        },
    );
    return { engine, logs, upgrades };
}

// Copies a fixture directory into /ws. `from` is relative to the repo.
export function stage(from: string, to = '.'): void {
    fs.cpSync(path.join(REPO, from), path.join(WS, to), { recursive: true, filter: (source) => path.basename(source) !== 'build' });
}

// The suite's numeric arguments, each a positive number, else its default, and its --flags. A
// mistyped argument stops the suite, rather than letting it pass having run nothing.
export function parseArgs(defaults: readonly number[], flags: readonly string[] = []): { numbers: number[], flags: Set<string> } {
    const args = process.argv.slice(2);
    const given = new Set(args.filter((a) => a.startsWith('--')));
    for (const flag of given) if (!flags.includes(flag)) throw new Error(`unknown option ${flag}`);
    const values = args.filter((a) => !a.startsWith('--'));
    if (values.length > defaults.length) throw new Error(`expected at most ${defaults.length} numbers, got: ${values.join(' ')}`);
    const numbers = defaults.map((fallback, i) => {
        if (i >= values.length) return fallback;
        const value = Number(values[i]);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`expected a positive number, got '${values[i]}'`);
        return value;
    });
    return { numbers, flags: given };
}

// The image's Ceedling release, asked once. Suites gate on capabilities(), which the engine's own
// gates read too. A wrong table entry then shows only in a suite whose checks depend on the feature
// itself, as stress, gated, and layout do. latency and mixed follow the table either way.
let release: string | undefined;
export function ceedlingVersion(): string {
    if (release === undefined) {
        const output = child_process.execFileSync('ceedling', ['version'], { encoding: 'utf8' });
        const reported = parseCeedlingVersions(output);
        release = reported && applicationRelease(reported)?.release;
        if (release === undefined) throw new Error(`no Ceedling version in: ${output}`);
    }
    return release;
}

export function capabilities(): CeedlingCapabilities {
    return capabilitiesOf(ceedlingVersion());
}

// Whether the image's Ceedling has `feature`. If not, says why the suite skips.
export function requires(feature: CeedlingFeature, reason: string): boolean {
    if (capabilities()[feature]) return true;
    console.log(`skipped: Ceedling ${ceedlingVersion()} ${reason}`);
    return false;
}

export function fileOf(project: CeedlingProjectNode, id: string): CeedlingFileNode {
    const file = project.files.find((f) => f.id === id);
    if (!file) throw new Error(`discovery found no ${id} in ${project.projectKey}`);
    return file;
}

// Where suites find other Ceedling installations to select. See sidecar/validate.Dockerfile.
export const INSTALLATIONS = '/opt/ceedling';

// Each test's result, in id order, so runs compare whatever order their results arrive in.
export const tally = (results: ReadonlyMap<string, string>) => [...results].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => `${id}=${r}`).join(', ');

// Every executable named `name` under a build root's test/out, relative to it, newest first.
export function executables(buildRoot: string, name: string): string[] {
    const out = path.join(buildRoot, 'test', 'out');
    if (!fs.existsSync(out)) return [];
    const modified = (relative: string) => fs.statSync(path.join(out, relative)).mtimeMs;
    return fs.readdirSync(out, { recursive: true, encoding: 'utf8' })
        .filter((relative) => path.basename(relative) === name && fs.statSync(path.join(out, relative)).isFile())
        .sort((a, b) => modified(b) - modified(a));
}

// Deletes every executable named `name`, so the next build of its test links one. A delta build
// otherwise leaves an up-to-date executable as it was, whatever its source's timestamp.
export function removeExecutables(buildRoot: string, name: string): void {
    for (const relative of executables(buildRoot, name)) fs.rmSync(path.join(buildRoot, 'test', 'out', relative));
}

// The one executable named `name` under a build root's test/out, relative to it. undefined when
// there is none or several. After removeExecutables(), it is what the next build wrote. A suite
// compares the engine's debug path with it, rather than with a layout it assumes.
export function builtExecutable(buildRoot: string, name: string): string | undefined {
    const built = executables(buildRoot, name);
    return built.length === 1 ? built[0] : undefined;
}

// Ceedling run directly, as the engine would run it, with the engine's environment and the current
// WHICH_CEEDLING. `exception` is Ceedling's EXCEPTION text, if it stopped with one.
export function ceedlingAlone(args: readonly string[], cwd: string): { runs: boolean, output: string, exception: string | undefined } {
    const result = child_process.spawnSync('ceedling', args, { cwd, encoding: 'utf8', timeout: 300000, env: ceedlingEnvironment(process.env) });
    const output = `${result.stdout}\n${result.stderr}`;
    return { runs: result.status === 0, output, exception: /EXCEPTION:\s*(.*)$/m.exec(output)?.[1]?.trim() };
}

// How much later a lock's release can reach a waiting command than the build's own end.
const LOCK_HANDOFF_MS = 100;

// Starts a full build of the project, rediscovers 300 ms later, then waits for both. Times are
// Date.now(). `dumpconfigAt` is when discovery's dumpconfig started, Infinity if it never ran.
// `heldBack` says the project's locks held it until the build ended.
export async function rediscoverDuringBuild(engine: CeedlingEngine, logs: readonly LogCall[], project: CeedlingProjectNode, reporter: RunReporter):
    Promise<{ discoveryStart: number, discoveryEnd: number, dumpconfigAt: number, buildEnd: number, heldBack: boolean, discovered: CeedlingProjectNode[] }> {
    const run = engine.runProjectAll(project.projectKey, project.files, reporter, cancellation()).then(() => Date.now());
    try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const discoveryStart = Date.now();
        const mark = logs.length;
        const discovered = await engine.discover();
        const discoveryEnd = Date.now();
        const buildEnd = await run;
        const dumpconfigAt = logs.slice(mark).find((l) => /^ceedling: \S+ dumpconfig/.test(l.message))?.at ?? Infinity;
        return { discoveryStart, discoveryEnd, dumpconfigAt, buildEnd, heldBack: dumpconfigAt >= buildEnd - LOCK_HANDOFF_MS, discovered };
    } finally {
        await run.catch(() => undefined);
    }
}

export function hasCommand(name: string): boolean {
    return child_process.spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
}

export { cancellation as token };

// Xorshift, so one seed always replays the same sequence of operations.
export function seeded(seed: number): { random: () => number, pick: <T>(list: readonly T[]) => T } {
    let state = seed >>> 0 || 1;
    const random = () => {
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        return state / 4294967296;
    };
    return { random, pick: (list) => list[Math.floor(random() * list.length)] };
}

// The one project a suite's workspace holds.
export function only<T>(projects: readonly T[]): T {
    if (projects.length !== 1) throw new Error(`discovery found ${projects.length} projects, not 1`);
    return projects[0];
}

// A reporter that keeps each id's last result and every coverage outcome.
export function recordingReporter(): RunReporter & { results: Map<string, string>, outcomes: CoverageOutcome[], last(): CoverageOutcome | undefined } {
    const results = new Map<string, string>();
    const outcomes: CoverageOutcome[] = [];
    return {
        results, outcomes,
        last: () => outcomes.length ? outcomes[outcomes.length - 1] : undefined,
        started() { },
        passed: (id) => results.set(id, 'passed'),
        failed: (id) => results.set(id, 'failed'),
        skipped: (id) => results.set(id, 'skipped'),
        errored: (id, message) => results.set(id, `errored: ${message.split('\n')[0]}`),
        appendOutput() { },
        coverage: (outcome) => outcomes.push(outcome),
    };
}

// Hits on one line of one covered file, by the end of its path.
export function hits(outcome: CoverageOutcome | undefined, file: string, line: number): number | undefined {
    if (outcome?.kind !== 'report') return undefined;
    return outcome.files.find((f) => f.path.endsWith(file))?.lines.find((l) => l.line === line)?.hits;
}

export function describeOutcome(outcome: CoverageOutcome): string {
    if (outcome.kind === 'missing') return `missing: ${outcome.message.slice(0, 160)}`;
    const files = outcome.files.map((f) => `${path.relative(WS, f.path)}[${f.lines.map((l) => `${l.line}:${l.hits}`).join(' ')}]`);
    return `${path.basename(path.dirname(outcome.path))}/${path.basename(outcome.path)}: ${files.join(' ')}`;
}

// Every broken expectation, plus any promise rejection nothing handled.
export class Checks {
    readonly violations: string[] = [];
    constructor() {
        process.on('unhandledRejection', (reason) => this.fail(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`));
    }
    fail(message: string): void { this.violations.push(message); }
    expect(condition: boolean, message: string): void { if (!condition) this.fail(message); }
}

// Runs `operation` repeatedly for `seconds`, with up to `maxInFlight` at once, then waits for all.
export async function churn(seconds: number, maxInFlight: number, operation: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    const running = new Set<Promise<void>>();
    while (Date.now() < deadline) {
        while (running.size < maxInFlight) {
            const next: Promise<void> = operation().finally(() => running.delete(next));
            running.add(next);
        }
        // eslint-disable-next-line no-await-in-loop -- refill as each operation finishes
        await Promise.race(running);
    }
    await Promise.allSettled([...running]);
}

// Ceedling, test executables, or coverage tools still running once every operation has settled,
// and the engine's dumpconfig temp files still on disk. A cancelled run must leave neither.
export async function leftovers(): Promise<string[]> {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const processes = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid).flatMap((entry) => {
        try {
            const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
            return /ceedling|ruby|\.out\b|gcovr|reportgenerator/.test(command) ? [`process ${entry}: ${command.slice(0, 100)}`] : [];
        } catch {
            return []; // exited while being read
        }
    });
    const temps = fs.readdirSync('/tmp').filter((file) => file.startsWith('ceedling-dumpconfig-')).map((file) => `temp file /tmp/${file}`);
    return [...processes, ...temps];
}

// Logged lines other than debug and trace, most frequent first.
export function logSummary(logs: readonly LogCall[], limit = 8): string[] {
    const counts = new Map<string, number>();
    for (const { level, message } of logs) {
        if (level === 'debug' || level === 'trace') continue;
        const key = `${level}: ${message.slice(0, 100)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([line, count]) => `${count}x ${line}`);
}

// Runs a suite, prints its verdict, and exits 0 only when it ran to the end with no violations.
export function main(name: string, suite: (checks: Checks) => Promise<void>): void {
    const checks = new Checks();
    suite(checks).then(() => {
        const distinct = [...new Set(checks.violations)];
        console.log(`${name}: ${checks.violations.length} violations (${distinct.length} distinct)`);
        for (const violation of distinct.slice(0, 30)) console.log(`  - ${violation.slice(0, 400)}`);
        process.exit(checks.violations.length ? 1 : 0);
    }, (error: unknown) => {
        console.log(`${name}: stopped: ${error instanceof Error ? error.stack : String(error)}`);
        for (const violation of [...new Set(checks.violations)].slice(0, 30)) console.log(`  - ${violation.slice(0, 400)}`);
        process.exit(1);
    });
}
