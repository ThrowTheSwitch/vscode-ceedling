import * as assert from 'assert';
import { debugTarget, resolveLaunchConfig } from '../../src/debugLaunch';
import { type RunPlanEntry } from '../../src/runPlan';
import { type CeedlingFileNode } from '../../src/testModel';

function file(projectKey: string, id: string): CeedlingFileNode {
    return { id, label: id, absPath: `/ws/${id}`, projectKey, functions: [{ id: `${id}::test_a`, label: 'a', line: 0, cases: [] }, { id: `${id}::test_b`, label: 'b', line: 1, cases: [] }] };
}

const fileA = file('p', 'test/test_a.c');
const fileB = file('p', 'test/test_b.c');
const otherA = file('q', 'test/test_a.c');

suite('debugTarget', () => {
    test('nothing to debug in an empty plan', () => {
        assert.strictEqual(debugTarget([]), undefined);
    });

    test('a file entry debugs that file alone', () => {
        assert.deepStrictEqual(debugTarget([{ kind: 'file', projectKey: 'p', file: fileA }]), { file: fileA, severalFiles: false });
    });

    test('several functions of one file are still one file', () => {
        const plan: RunPlanEntry[] = [
            { kind: 'function', projectKey: 'p', file: fileA, fn: fileA.functions[0] },
            { kind: 'function', projectKey: 'p', file: fileA, fn: fileA.functions[1] },
        ];
        assert.deepStrictEqual(debugTarget(plan), { file: fileA, severalFiles: false });
    });

    // Ceedling builds one executable per test file, so only one file can be debugged at a time.
    test('a plan naming several files debugs the first and says there were several', () => {
        assert.deepStrictEqual(debugTarget([{ kind: 'project', projectKey: 'p', files: [fileA, fileB] }]), { file: fileA, severalFiles: true });
    });

    test('files with the same path in different projects are different files', () => {
        const plan: RunPlanEntry[] = [{ kind: 'file', projectKey: 'p', file: fileA }, { kind: 'file', projectKey: 'q', file: otherA }];
        assert.deepStrictEqual(debugTarget(plan), { file: fileA, severalFiles: true });
    });
});

suite('resolveLaunchConfig', () => {
    const TOKEN = '${command:ceedlingExplorer.debugTestExecutable}';
    const gdb = { name: 'gdb', type: 'cppdbg', program: `\${workspaceFolder}/build/test/out/${TOKEN}`, args: [TOKEN, '--flag'], env: { EXE: TOKEN }, stopAtEntry: false, port: 3333, miDebuggerPath: null };
    const configurations: Array<Record<string, unknown> & { name: string }> = [{ name: 'other', type: 'cppdbg', program: 'x' }, gdb];

    test('a name not in launch.json resolves to nothing', () => {
        assert.strictEqual(resolveLaunchConfig(configurations, 'missing', 'x/x.out'), undefined);
    });

    test("every occurrence of the token becomes the executable's path, everything else untouched", () => {
        assert.deepStrictEqual(resolveLaunchConfig(configurations, 'gdb', 'test_calc/test_calc.out'), {
            name: 'gdb', type: 'cppdbg',
            program: '${workspaceFolder}/build/test/out/test_calc/test_calc.out',
            args: ['test_calc/test_calc.out', '--flag'],
            env: { EXE: 'test_calc/test_calc.out' },
            stopAtEntry: false, port: 3333, miDebuggerPath: null,
        });
    });

    test('the configuration from launch.json is left unchanged', () => {
        resolveLaunchConfig(configurations, 'gdb', 'test_calc/test_calc.out');
        assert.strictEqual(gdb.args[0], TOKEN);
    });

    test('a path with backslashes, quotes, or replacement patterns arrives intact', () => {
        const subpath = 'unit\\test "odd" $& $1/test.exe';
        assert.deepStrictEqual(resolveLaunchConfig(configurations, 'gdb', subpath)?.args, [subpath, '--flag']);
    });
});
