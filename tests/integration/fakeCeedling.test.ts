import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
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

// `detail` explains a timeout, e.g. with the paths being compared.
async function waitFor(condition: () => boolean, what: string, detail = () => '', timeoutMs = 15000): Promise<void> {
    for (const deadline = Date.now() + timeoutMs; !condition();) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}. ${detail()}`);
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

    // Runs the items, recording each result by item id. `whileRunning` may cancel the run.
    async function run(ids: string[], whileRunning?: (cancel: () => void) => Promise<void>, coverage = false): Promise<Map<string, ReportedResult[]>> {
        const results = new Map<string, ReportedResult[]>();
        const listener = controller.onDidReport((result) => { results.set(result.item.id, [...(results.get(result.item.id) ?? []), result]); });
        const source = new vscode.CancellationTokenSource();
        try {
            const running = controller.run(new vscode.TestRunRequest(ids.map(item)), source.token, coverage);
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
        const api = await vscode.extensions.getExtension<CeedlingExplorerApi | undefined>(EXTENSION_ID)!.activate();
        assert.ok(api, 'the extension returns its test API in test mode');
        const found = api.controllerFor(project().uri);
        assert.ok(found, 'a controller for the fake project');
        controller = found;
        await controller.whenDiscovered();
    });

    test('a folder without a Ceedling project adds nothing to the Testing view', async () => {
        const api = await vscode.extensions.getExtension<CeedlingExplorerApi | undefined>(EXTENSION_ID)!.activate();
        assert.ok(api);
        const without = api.controllerFor(folderNamed('without-project').uri);
        await without?.whenDiscovered();
        assert.ok(!fs.existsSync(vscode.Uri.joinPath(folderNamed('without-project').uri, 'fake-ceedling.log').fsPath), 'Ceedling never ran there');
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
            ['test/test_calc.c::test_add_more', 'add_more', 23],
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

    // Ceedling's filter is a substring match, so --test-case=test_add also runs test_add_more.
    test('a function run whose filter also selects another function reruns the whole file', async () => {
        const before = invocations().length;
        const results = await run(['test/test_calc.c::test_add']);
        assert.deepStrictEqual(invocations().slice(before).filter((args) => args[0]?.startsWith('test:')).map((args) => args.filter((a) => /^(test:|--test-case)/.test(a))),
            [['test:test/test_calc.c', '--test-case=test_add'], ['test:test/test_calc.c']]);
        assert.ok(outcome(results, 'test/test_calc.c::test_add')?.includes('passed'));
        assert.ok(outcome(results, 'test/test_calc.c::test_sub')?.includes('failed'));
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

    // As after upgrading to Ceedling 1.2.2 from 1.2.1, whose cache the fake's next build sets aside.
    // The notice shows during the run's first build. A clobber before its second would rebuild it all.
    test("a build Ceedling moved to a new layout offers to clobber that project, once the run ends", async () => {
        const cache = fileUri('build', 'cache', '.test.dep_cache.json').fsPath;
        fs.mkdirSync(path.dirname(cache), { recursive: true });
        fs.writeFileSync(cache, JSON.stringify({ schema_version: 1, entries: {} }));
        const offers: Array<{ message: string, actions: string[] }> = [];
        const window = vscode.window as { showWarningMessage: (message: string, ...actions: string[]) => Thenable<string | undefined> };
        const original = window.showWarningMessage;
        window.showWarningMessage = async (message, ...actions) => {
            offers.push({ message, actions });
            return actions.find((action) => action === 'Clobber');
        };
        try {
            const before = invocations().length;
            await run(['test/test_calc.c', 'test/test_unreported.c']);
            await waitFor(() => invocations().slice(before).some((args) => args[0] === 'clobber'), 'the offered clobber', () => JSON.stringify(offers));
            assert.deepStrictEqual(invocations().slice(before).map((args) => args[0]), ['test:test/test_calc.c', 'test:test/test_unreported.c', 'clobber']);
            assert.deepStrictEqual(offers.map((offer) => offer.actions), [['Clobber']]);
            assert.match(offers[0].message, /Clobber to remove the output left in the old layout/);
            await waitFor(() => !fs.existsSync(cache), 'the clobber to remove the build root');
        } finally {
            window.showWarningMessage = original;
        }
    });

    // A profile of its own kind, so a plain run never pays for instrumentation.
    test('a project with the gcov plugin offers Run with Coverage', () => {
        assert.strictEqual(controller.coverageRunProfile?.kind, vscode.TestRunProfileKind.Coverage);
    });

    test("a coverage run reports its tests and each covered file, whose details load on request", async () => {
        const covered: vscode.FileCoverage[] = [];
        const listener = controller.onDidReportCoverage((fileCoverage) => covered.push(fileCoverage));
        let results: Map<string, ReportedResult[]>;
        try {
            results = await run(['test/test_calc.c'], undefined, true);
        } finally {
            listener.dispose();
        }
        assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_add'), ['passed']);
        const [task, ...rest] = invocations().filter((args) => args[0]?.startsWith('gcov:')).pop() ?? [];
        assert.deepStrictEqual([task, rest[0]], ['gcov:test_calc.c', '--force-test-rerun']);
        assert.deepStrictEqual(covered.map((c) => c.uri.toString()), [fileUri('src', 'calc.c').toString()]);
        const [calc] = covered;
        assert.deepStrictEqual([calc.statementCoverage.covered, calc.statementCoverage.total], [2, 3]);
        assert.deepStrictEqual([calc.branchCoverage?.covered, calc.branchCoverage?.total], [1, 2]);
        assert.deepStrictEqual([calc.declarationCoverage?.covered, calc.declarationCoverage?.total], [1, 1]);
        const testRun = controller.testController!.createTestRun(new vscode.TestRunRequest());
        const source = new vscode.CancellationTokenSource();
        try {
            const details = await controller.coverageRunProfile!.loadDetailedCoverage!(testRun, calc, source.token);
            assert.deepStrictEqual(details.map((d) => d instanceof vscode.DeclarationCoverage ? `${d.name}@${(d.location as vscode.Position).line}` : `${String(d.executed)}@${(d.location as vscode.Position).line}`),
                ['3@0', '0@1', '1@3', 'add@0']);
        } finally {
            testRun.end();
            source.dispose();
        }
    });

    // Run with Coverage still runs the tests, and says what the project must configure.
    test('a coverage run in a project writing no Cobertura report explains what to add', async () => {
        const scenarioFile = fileUri('fake-ceedling.json').fsPath;
        const original = fs.readFileSync(scenarioFile, 'utf8');
        const problems: string[] = [];
        const covered: vscode.FileCoverage[] = [];
        const listeners = [controller.onDidReportCoverageProblem((p) => problems.push(p)), controller.onDidReportCoverage((c) => covered.push(c))];
        try {
            const scenario = JSON.parse(original) as { gcov: { reports: string[] } };
            scenario.gcov.reports = [];
            fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
            await controller.whenDiscovered();
            const results = await run(['test/test_calc.c'], undefined, true);
            assert.deepStrictEqual(outcome(results, 'test/test_calc.c::test_add'), ['passed']);
            assert.deepStrictEqual(covered, []);
            assert.strictEqual(problems.length, 1);
            assert.match(problems[0] ?? '', /Cobertura[\s\S]*:reports:/);
        } finally {
            listeners.forEach((l) => { l.dispose(); });
            fs.writeFileSync(scenarioFile, original);
            await controller.whenDiscovered();
        }
    });

    test('the Coverage profile follows the gcov plugin across rediscovery', async () => {
        const scenarioFile = fileUri('fake-ceedling.json').fsPath;
        const original = fs.readFileSync(scenarioFile, 'utf8');
        try {
            const scenario = JSON.parse(original) as Record<string, unknown>;
            delete scenario.gcov;
            fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
            await controller.whenDiscovered();
            assert.strictEqual(controller.coverageRunProfile, undefined);
        } finally {
            fs.writeFileSync(scenarioFile, original);
            await controller.whenDiscovered();
        }
        assert.ok(controller.coverageRunProfile);
    });

    test('a new test file on disk is discovered, and a deleted one goes', async () => {
        const created = fileUri('test', 'test_new.c');
        await vscode.workspace.fs.writeFile(created, Buffer.from('void test_fresh(void)\n{\n}\n'));
        await waitFor(() => findItem(items(), 'test/test_new.c::test_fresh') !== undefined, 'the new test file to appear');
        await vscode.workspace.fs.delete(created);
        await waitFor(() => findItem(items(), 'test/test_new.c') === undefined, 'the deleted test file to go',
            () => `Deleted '${created.fsPath}'; discovered '${findItem(items(), 'test/test_new.c')?.uri?.fsPath}'.`);
    });

    test('an edit to an open test file updates its tests before it is saved', async () => {
        const document = await vscode.workspace.openTextDocument(fileUri('test', 'test_calc.c'));
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(document.lineCount, 0), '\nvoid test_typed(void)\n{\n}\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await waitFor(() => findItem(items(), 'test/test_calc.c::test_typed') !== undefined, 'the typed test to appear',
            () => `Edited '${document.uri.fsPath}' (${document.uri.toString()}); discovered '${item('test/test_calc.c').uri?.fsPath}' (${item('test/test_calc.c').uri?.toString()}).`);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await waitFor(() => findItem(items(), 'test/test_calc.c::test_typed') === undefined, 'the reverted test to go');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
});
