import * as assert from 'assert';
import { buildRunPlan, PlanTarget, RunPlanEntry } from '../../src/runPlan';
import { CeedlingFileNode, CeedlingProjectNode } from '../../src/testModel';

function file(projectKey: string, id: string, functions: Array<string | [string, string[]]>): CeedlingFileNode {
    return {
        id, label: id, absPath: `/ws/${id}`, projectKey,
        functions: functions.map((fn) => {
            const [name, cases] = typeof fn === 'string' ? [fn, []] : fn;
            return { id: `${id}::${name}`, label: name, line: 0, cases: cases.map((args) => ({ id: `${id}::${name}(${args})`, label: args, line: 0 })) };
        }),
    };
}

const fileA = file('p', 'test/test_a.c', ['test_1', 'test_2', ['test_p', ['1', '2']]]);
const fileB = file('p', 'test/test_b.c', ['test_3']);
const fileQ = file('q', 'test/test_q.c', ['test_4']);
const projects: CeedlingProjectNode[] = [
    { projectKey: 'p', label: 'p', files: [fileA, fileB] },
    { projectKey: 'q', label: 'q', files: [fileQ] },
];

const project = (projectKey: string): PlanTarget => ({ kind: 'project', projectKey });
const fileTarget = (f: CeedlingFileNode): PlanTarget => ({ kind: 'file', projectKey: f.projectKey, fileId: f.id });
const fn = (f: CeedlingFileNode, name: string): PlanTarget => ({ kind: 'function', projectKey: f.projectKey, fileId: f.id, functionId: `${f.id}::${name}` });
const testCase = (f: CeedlingFileNode, name: string, args: string): PlanTarget =>
    ({ kind: 'case', projectKey: f.projectKey, fileId: f.id, functionId: `${f.id}::${name}`, caseId: `${f.id}::${name}(${args})` });

// A compact view of a plan: `project:p`, `file:test/test_a.c`, `function:test/test_a.c::test_1`.
function summarize(plan: RunPlanEntry[]): string[] {
    return plan.map((entry) => entry.kind === 'project' ? `project:${entry.projectKey}`
        : entry.kind === 'file' ? `file:${entry.file.id}`
            : `function:${entry.fn.id}`);
}

suite('buildRunPlan', () => {
    // Running everything never uses the bulk `test:all`, so every file reports separately.
    test('running everything runs each file of each project', () => {
        assert.deepStrictEqual(summarize(buildRunPlan(projects, undefined, [])), ['file:test/test_a.c', 'file:test/test_b.c', 'file:test/test_q.c']);
    });

    test('a project node runs the whole project at once', () => {
        const plan = buildRunPlan(projects, [project('p')], []);
        assert.deepStrictEqual(summarize(plan), ['project:p']);
        assert.deepStrictEqual((plan[0] as Extract<RunPlanEntry, { kind: 'project' }>).files, [fileA, fileB]);
    });

    test('a function runs alone', () => {
        assert.deepStrictEqual(summarize(buildRunPlan(projects, [fn(fileA, 'test_2')], [])), ['function:test/test_a.c::test_2']);
    });

    // Ceedling's --test-case filter selects a function, never one case of it.
    test('a case runs its whole function', () => {
        assert.deepStrictEqual(summarize(buildRunPlan(projects, [testCase(fileA, 'test_p', '1')], [])), ['function:test/test_a.c::test_p']);
    });

    test('a file and a function within it run as the file, once', () => {
        assert.deepStrictEqual(summarize(buildRunPlan(projects, [fn(fileA, 'test_1'), fileTarget(fileA)], [])), ['file:test/test_a.c']);
    });

    test('every function of a file selected one by one runs as the file', () => {
        const plan = buildRunPlan(projects, [fn(fileA, 'test_1'), fn(fileA, 'test_2'), fn(fileA, 'test_p')], []);
        assert.deepStrictEqual(summarize(plan), ['file:test/test_a.c']);
    });

    test('duplicate targets run once, and entries follow tree order', () => {
        const plan = buildRunPlan(projects, [fileTarget(fileB), fn(fileA, 'test_1'), fileTarget(fileB)], []);
        assert.deepStrictEqual(summarize(plan), ['function:test/test_a.c::test_1', 'file:test/test_b.c']);
    });

    test('a stale target naming nothing in the tree is ignored', () => {
        assert.deepStrictEqual(buildRunPlan(projects, [fn(fileA, 'test_gone'), project('nope')], []), []);
    });

    suite('exclusions', () => {
        test('an excluded file drops out of a project run, which then runs file by file', () => {
            assert.deepStrictEqual(summarize(buildRunPlan(projects, [project('p')], [fileTarget(fileA)])), ['file:test/test_b.c']);
        });

        test('an excluded function splits its file into the remaining functions', () => {
            assert.deepStrictEqual(summarize(buildRunPlan(projects, [fileTarget(fileA)], [fn(fileA, 'test_2')])),
                ['function:test/test_a.c::test_1', 'function:test/test_a.c::test_p']);
        });

        test('an excluded project drops out of running everything', () => {
            assert.deepStrictEqual(summarize(buildRunPlan(projects, undefined, [project('q')])), ['file:test/test_a.c', 'file:test/test_b.c']);
        });

        // One case can't be left out of its function's run. The caller drops its result instead.
        test('excluding some cases of a function still runs the function', () => {
            assert.deepStrictEqual(summarize(buildRunPlan(projects, [fileTarget(fileA)], [testCase(fileA, 'test_p', '1')])), ['file:test/test_a.c']);
        });

        test('excluding every case of a function excludes the function', () => {
            const plan = buildRunPlan(projects, [fileTarget(fileA)], [testCase(fileA, 'test_p', '1'), testCase(fileA, 'test_p', '2')]);
            assert.deepStrictEqual(summarize(plan), ['function:test/test_a.c::test_1', 'function:test/test_a.c::test_2']);
        });

        test('excluding every function of a file leaves nothing to run', () => {
            assert.deepStrictEqual(buildRunPlan(projects, [fileTarget(fileB)], [fn(fileB, 'test_3')]), []);
        });
    });
});
