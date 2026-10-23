import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { CeedlingExplorerApi } from '../../src/main';
import type { CeedlingTestController, ReportedResult } from '../../src/testController';

// Runs inside a real VS Code against the fake Ceedling project (see main.ts and
// tests/fixtures/workspace-fake-ceedling). Unit tests cover the decisions. These check the wiring:
// TestItems built from discovery, results reaching the Testing view, diagnostics reaching the
// Problems panel, cancellation, and the watchers and edits that keep the tree current. On the
// Windows CI leg the engine runs with Windows paths, which unit tests can't reach.

const EXTENSION_ID = 'throw-the-switch.vscode-ceedling';

function folderNamed(name: string): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.name === name);
    assert.ok(folder, `workspace folder '${name}'`);
    return folder;
}

function findItem(items: vscode.TestItemCollection, id: string): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    items.forEach((item) => { found ??= item.id === id ? item : findItem(item.children, id); });
    return found;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
    for (const deadline = Date.now() + timeoutMs; !condition();) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        // eslint-disable-next-line no-await-in-loop -- polling
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

suite('Extension against a fake Ceedling', function () {
    this.timeout(60000);
    const project = () => folderNamed('fake-project');
    const fileUri = (...segments: string[]) => vscode.Uri.joinPath(project().uri, ...segments);
    let controller: CeedlingTestController;
    const items = () => {
        assert.ok(controller.testController, 'the fake project has a TestController');
        return controller.testController.items;
    };
    const item = (id: string) => {
        const found = findItem(items(), id);
        assert.ok(found, `TestItem '${id}'`);
        return found;
    };
    // Every invocation of the fake, as its arguments.
    const invocations = (): string[][] => fs.readFileSync(fileUri('fake-ceedling.log').fsPath, 'utf8')
        .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as string[]);

    // Runs the items, recording each result by item id. `whileRunning` sees the run's token.
    async function run(ids: string[], whileRunning?: (cancel: () => void) => Promise<void>): Promise<Map<string, ReportedResult[]>> {
        const results = new Map<string, ReportedResult[]>();
        const listener = controller.onDidReport((result) => { results.set(result.item.id, [...(results.get(result.item.id) ?? []), result]); });
        const source = new vscode.CancellationTokenSource();
        try {
            const running = controller.run(new vscode.TestRunRequest(ids.map(item)), source.token);
            await whileRunning?.(() => { source.cancel(); });
            await running;
        } finally {
            listener.dispose();
            source.dispose();
        }
        return results;
    }
    const outcome = (results: Map<string, ReportedResult[]>, id: string) => results.get(id)?.filter((r) => r.outcome !== 'started').map((r) => r.outcome);
    const reported = (results: Map<string, ReportedResult[]>, id: string, kind: ReportedResult['outcome']) => results.get(id)?.find((r) => r.outcome === kind);
    const text = (message: vscode.TestMessage | undefined) => typeof message?.message === 'string' ? message.message : message?.message.value ?? '';

    suiteSetup(async () => {
        const api = await vscode.extensions.getExtension<CeedlingExplorerApi>(EXTENSION_ID)!.activate();
        const found = api.controllerFor(project().uri);
        assert.ok(found, 'a controller for the fake project');
        controller = found;
        await controller.whenDiscovered();
    });

    test('a folder without a Ceedling project adds nothing to the Testing view', async () => {
        const api = await vscode.extensions.getExtension<CeedlingExplorerApi>(EXTENSION_ID)!.activate();
        const without = api.controllerFor(folderNamed('without-project').uri);
        await without?.whenDiscovered();
        assert.strictEqual(without?.testController, undefined);
    });

    test("discovery builds the tree from Ceedling's file list and each file's tests, named for the folder", () => {
        assert.strictEqual(controller.testController?.label, 'Ceedling (fake-project)');
        const files: string[] = [];
        items().forEach((file) => files.push(file.id));
        assert.deepStrictEqual(files.sort(), ['test/test_broken.c', 'test/test_calc.c', 'test/test_slow.c', 'test/test_unreported.c']);
        const calc = item('test/test_calc.c');
        assert.strictEqual(calc.label, 'calc');
        assert.strictEqual(calc.uri?.toString(), fileUri('test', 'test_calc.c').toString());
        const functions: Array<[string, string, number | undefined]> = [];
        calc.children.forEach((fn) => functions.push([fn.id, fn.label, fn.range?.start.line]));
        assert.deepStrictEqual(functions, [
            ['test/test_calc.c::test_add', 'add', 2],
            ['test/test_calc.c::test_sub', 'sub', 6],
            ['test/test_calc.c::test_skip', 'skip', 11],
            ['test/test_calc.c::test_param', 'param', 18],
        ]);
        const cases: Array<[string, number | undefined]> = [];
        item('test/test_calc.c::test_param').children.forEach((c) => cases.push([c.id, c.range?.start.line]));
        assert.deepStrictEqual(cases, [['test/test_calc.c::test_param(1)', 16], ['test/test_calc.c::test_param(2)', 17]]);
    });

    test("a file run reports each test's result, a failure at its assertion's line", async () => {
        const results = await run(['test/test_calc.c']);
        assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_add'), ['passed']);
        assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_skip'), ['skipped']);
        assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_param(1)'), ['passed']);
        assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_param(2)'), ['passed']);
        const failure = reported(results, 'test/test_calc.c::test_sub', 'failed');
        assert.match(text(failure?.message), /^Expected 1 Was 2/);
        assert.strictEqual(failure?.message?.location?.range.start.line, 8);
        assert.strictEqual(failure.message.location.uri.toString(), fileUri('test', 'test_calc.c').toString());
        const [task, ...rest] = invocations().filter((args) => args[0]?.startsWith('test:')).pop() ?? [];
        assert.strictEqual(task, 'test:test/test_calc.c');
        assert.deepStrictEqual(rest.slice(0, 3), ['--force-test-rerun', '--project', 'project.yml']);
        assert.match(rest[rest.length - 1] ?? '', /report-tests-log-factory\.yml$/);
    });

    test('a function run narrows with --test-case and reports only that function', async () => {
        const results = await run(['test/test_calc.c::test_sub']);
        assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_sub'), ['failed']);
        assert.strictEqual(results.get('test/test_calc.c::test_add'), undefined);
        assert.ok(invocations().some((args) => args[0] === 'test:test/test_calc.c' && args.includes('--test-case=test_sub')));
    });

    test('a test missing from the report errors, saying Ceedling reported no result', async () => {
        const results = await run(['test/test_unreported.c']);
        assert.deepStrictEqual(outcome(results, 'test/test_unreported.c::test_reported'), ['passed']);
        assert.match(text(reported(results, 'test/test_unreported.c::test_forgotten', 'errored')?.message), /reported no result/);
    });

    test('a compile failure errors the file\'s tests and reaches the Problems panel at its line', async () => {
        const results = await run(['test/test_broken.c']);
        const error = reported(results, 'test/test_broken.c::test_add_should_ReturnSum', 'errored');
        assert.match(text(error?.message), /expected ‘;’ before ‘}’ token/);
        assert.strictEqual(error?.message?.location?.range.start.line, 8);
        const diagnostics = vscode.languages.getDiagnostics(fileUri('test', 'test_broken.c'));
        assert.ok(diagnostics.some((d) => /expected ‘;’ before ‘}’ token/.test(d.message) && d.range.start.line === 8 && d.severity === vscode.DiagnosticSeverity.Error),
            `diagnostics: ${JSON.stringify(diagnostics.map((d) => [d.message, d.range.start.line]))}`);
    });

    test('cancelling a run stops Ceedling and marks its tests skipped', async () => {
        const started = Date.now();
        const results = await run(['test/test_slow.c'], async (cancel) => {
            await waitFor(() => invocations().some((args) => args[0] === 'test:test/test_slow.c'), 'the fake to start the slow test');
            cancel();
        });
        assert.deepStrictEqual(outcome(results, 'test/test_slow.c::test_never_finishes'), ['skipped']);
        assert.ok(Date.now() - started < 30000, 'the run ended soon after cancellation');
    });

    test('a new test file on disk is discovered, and a deleted one goes', async () => {
        const created = fileUri('test', 'test_new.c');
        await vscode.workspace.fs.writeFile(created, Buffer.from('void test_fresh(void)\n{\n}\n'));
        await waitFor(() => findItem(items(), 'test/test_new.c::test_fresh') !== undefined, 'the new test file to appear');
        await vscode.workspace.fs.delete(created);
        await waitFor(() => findItem(items(), 'test/test_new.c') === undefined, 'the deleted test file to go');
    });

    test('an edit to an open test file updates its tests before it is saved', async () => {
        const document = await vscode.workspace.openTextDocument(fileUri('test', 'test_calc.c'));
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(document.lineCount, 0), '\nvoid test_typed(void)\n{\n}\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await waitFor(() => findItem(items(), 'test/test_calc.c::test_typed') !== undefined, 'the typed test to appear');
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await waitFor(() => findItem(items(), 'test/test_calc.c::test_typed') === undefined, 'the reverted test to go');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
});
