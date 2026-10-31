// Concurrency stress. Random runs, debug builds, discoveries, reparses, cleans, and clobbers
// overlap across four projects for a fixed time, a fifth of them cancelled at a random moment.
// Every completed run must report each of its tests exactly once, with the outcome tests/manual
// expects. Every discovery must list exactly the test files tests/manual holds, in every project.
// Nothing may be left running or on disk afterward.
//
// The projects are three copies of tests/manual. The third holds two project files, so two
// projects share one directory. --shared-build-root also gives all four one build root.
//
// usage: node stress.js [seconds=60] [maxInFlight=6] [seed=1] [--shared-build-root]
import * as fs from 'fs';
import * as path from 'path';
import { extractTestFunctionName } from '../../src/ceedlingOutputParsing';
import { leafIds, type CeedlingFileNode, type RunReporter } from '../../src/testModel';
import { churn, type Checks, leftovers, logSummary, main, makeEngine, parseArgs, seeded, stage, token, WS } from './harness';

// The outcome of every test in tests/manual, by function name.
const EXPECTED: Record<string, string> = {
    test_add_should_ReturnSum: 'passed',
    test_add_should_HandleSpaceBeforeParen: 'passed',
    test_add_should_ReturnSumButIsDeliberatelyWrong: 'failed',
    test_should_BeIgnored: 'skipped',
    test_should_crash: 'failed',
    test_add_ParameterizedCases: 'passed',
    test_add_MatrixCases: 'passed',
};
const expectedOf = (id: string) => EXPECTED[extractTestFunctionName(id)];

// Checks one run's reporting. Only `reportable` tests may report, by default the run's own, each
// once and none after the run returns. A run not cancelled must give each of its own the expected
// outcome.
function checkedReporter(checks: Checks, label: string, leaves: readonly string[], reportable = leaves) {
    const state = new Map<string, string>();
    let finished = false;
    const result = (kind: string) => (id: string, message?: string) => {
        checks.expect(reportable.includes(id), `${label}: ${kind} result for ${id}, which the run didn't select`);
        checks.expect(!finished, `${label}: ${kind} after the run returned (${id})`);
        checks.expect(state.get(id) === undefined || state.get(id) === 'started', `${label}: second result for ${id}`);
        state.set(id, kind === 'errored' ? `errored: ${String(message).split('\n').slice(0, 3).join(' | ')}` : kind);
    };
    const reporter: RunReporter = {
        started: (id) => { if (!state.has(id)) state.set(id, 'started'); },
        passed: result('passed'), failed: result('failed'), skipped: result('skipped'), errored: result('errored'),
        appendOutput() { }, coverage() { },
    };
    const check = (cancelled: boolean) => {
        finished = true;
        for (const leaf of leaves) {
            const got = state.get(leaf);
            checks.expect(got !== 'started', `${label}: ${leaf} left without a result`);
            if (!cancelled) checks.expect(got === expectedOf(leaf), `${label}: ${leaf} expected ${expectedOf(leaf)}, got ${got}`);
        }
    };
    return { reporter, check };
}

main('stress', async (checks) => {
    const { numbers: [seconds, maxInFlight, seed], flags } = parseArgs([60, 6, 1], ['--shared-build-root']);
    const sharedBuildRoot = flags.has('--shared-build-root');
    for (const project of ['a', 'b', 'c']) stage('tests/manual', project);
    fs.writeFileSync(path.join(WS, 'c/ci.yml'), ':project:\n  :use_test_preprocessor: :none\n');
    fs.writeFileSync(path.join(WS, 'c/other.yml'), ':unity:\n  :use_param_tests: true\n');
    fs.writeFileSync(path.join(WS, 'shared-build.yml'), `:project:\n  :build_root: ${WS}/shared-build\n`);
    const projects = ['a', 'b', 'c/ci.yml', 'c/other.yml'].map((p) => ({ path: p, debugLaunchConfig: 'dbg' }));
    const { engine, logs } = makeEngine({ projects, mixins: sharedBuildRoot ? [`${WS}/shared-build.yml`] : [] });
    const { random, pick } = seeded(seed);
    const leavesOf = (files: readonly CeedlingFileNode[]) => files.flatMap((f) => leafIds(f.functions));

    let tree = await engine.discover();
    console.log(`projects: ${tree.map((p) => `${p.projectKey} (${p.files.length} files)`).join(', ')}${sharedBuildRoot ? ', one build root' : ''}`);
    // Every project is a copy of tests/manual, so each lists the same test files.
    const manualTests = fs.readdirSync(path.join(WS, 'a/test')).filter((f) => f.startsWith('test_') && f.endsWith('.c')).map((f) => `test/${f}`).sort();
    const checkListing = (label: string) => {
        checks.expect(tree.length === 4, `${label} found ${tree.length} projects`);
        for (const p of tree) {
            const files = p.files.map((f) => f.id);
            checks.expect(files.slice().sort().join(' ') === manualTests.join(' '), `${label} listed ${p.projectKey}: ${files.join(' ')}, expected ${manualTests.join(' ')}`);
        }
    };
    checkListing('the first discovery');
    const counts: Record<string, number> = {};
    // Builds, cleans, and clobbers started and not yet returned, queued or running, and the
    // discoveries started meanwhile.
    let busy = 0, overlapped = 0;

    await churn(seconds, maxInFlight, async () => {
        let kind = pick(['runFile', 'runFile', 'runFunction', 'runProject', 'debug', 'discover', 'discover', 'clean', 'clobber', 'reparse']);
        const project = pick(tree);
        // A discovery that listed no files has already failed checkListing. The next one may recover.
        if (project.files.length === 0) kind = 'discover';
        const file = project.files.length > 0 ? pick(project.files) : { id: '(none)', functions: [] } as unknown as CeedlingFileNode;
        const t = token();
        if (random() < 0.2) setTimeout(() => t.fire(), Math.floor(random() * 3000));
        counts[kind] = (counts[kind] ?? 0) + 1;
        const label = `${kind} ${project.projectKey}/${file.id}`;
        const building = kind !== 'discover' && kind !== 'reparse';
        if (building) busy++;
        else if (kind === 'discover' && busy > 0) overlapped++;
        try {
            if (kind === 'runFile') {
                const run = checkedReporter(checks, label, leavesOf([file]));
                await engine.runFile(project.projectKey, file, run.reporter, t);
                run.check(t.isCancellationRequested);
            } else if (kind === 'runFunction') {
                const fn = pick(file.functions);
                // Ceedling's --test-case filter matches substrings, so a function whose name is part
                // of another's, e.g. test_add_should_ReturnSum, falls back to a whole-file run.
                const collides = file.functions.some((other) => other !== fn && extractTestFunctionName(other.id).includes(extractTestFunctionName(fn.id)));
                const run = checkedReporter(checks, `${label}::${fn.id}`, leafIds([fn]), collides ? leavesOf([file]) : leafIds([fn]));
                await engine.runFunction(project.projectKey, file, fn, run.reporter, t);
                run.check(t.isCancellationRequested);
            } else if (kind === 'runProject') {
                const run = checkedReporter(checks, label, leavesOf(project.files));
                await engine.runProjectAll(project.projectKey, project.files, run.reporter, t);
                run.check(t.isCancellationRequested);
            } else if (kind === 'debug') {
                const run = checkedReporter(checks, label, leavesOf([file]));
                await engine.compileForDebug(project.projectKey, file, run.reporter, t);
                run.check(t.isCancellationRequested);
            } else if (kind === 'discover') {
                tree = await engine.discover();
                checkListing('a discovery');
            } else if (kind === 'clean' || kind === 'clobber') {
                checks.expect(await engine[kind](t) || t.isCancellationRequested, `${kind} failed without being cancelled`);
            } else {
                await engine.rediscoverFile(project.projectKey, file.id);
            }
        } catch (error) {
            checks.fail(`${label} threw: ${error instanceof Error ? error.stack : String(error)}`);
        } finally {
            if (building) busy--;
        }
    });

    // The engine looks for a debug build's executable while it still holds the build's locks. Once
    // they're released, another project's build, a clean, or a clobber may replace it, so only that
    // check holds.
    for (const missing of logs.filter((l) => l.message.startsWith('executableSubpath:'))) checks.fail(missing.message);
    for (const leftover of await leftovers()) checks.fail(`left behind: ${leftover}`);
    engine.dispose();
    console.log(`${seconds} s, ${maxInFlight} at once, seed ${seed}; operations ${JSON.stringify(counts)}; discoveries started while a build, clean, or clobber was queued or running: ${overlapped}`);
    for (const line of logSummary(logs)) console.log(`  log ${line}`);
});
