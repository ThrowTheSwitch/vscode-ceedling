import crypto from 'crypto';
import path from 'path';
import util from 'util';
import vscode from 'vscode';
import { CeedlingEngine, CeedlingLoadError } from './ceedlingEngine';
import { debugTarget, resolveLaunchConfig } from './debugLaunch';
import { type Logger } from './logger';
import { ProblemMatcher } from './problemMatcher';
import { buildRunPlan, type PlanTarget, type RunPlanEntry } from './runPlan';
import { SingleFlight } from './singleFlight';
import { type CeedlingFileNode, type CeedlingProjectNode, type CeedlingTestFunction, type RunReporter } from './testModel';
import { createRunReporter, type ReportMessage } from './testReporting';
import { Debouncer, settingsChangeEffects, type SourceEvent, sourceEventEffect, watcherChanges } from './watchPolicy';

// Names the launch configuration of one debug request, so its debug session can be told apart
// from any other session VS Code starts meanwhile.
const DEBUG_REQUEST_KEY = '__ceedlingDebugRequest';
// How long typing pauses before an unsaved test file is reparsed.
const EDIT_REPARSE_DELAY_MS = 400;

// One result a run reported to the Testing view, for the integration tests. VS Code's API can't
// read another extension's run results.
export type ReportedResult = { item: vscode.TestItem, outcome: 'started' | 'passed' | 'failed' | 'skipped' | 'errored', message?: vscode.TestMessage };

// Mirrors one workspace folder's CeedlingEngine discovery and results onto a native
// vscode.TestController. Several Ceedling projects in one folder (ceedlingExplorer.projects)
// appear as sibling root items. The TestController exists only while the folder has a Ceedling
// project, so folders without one add nothing to the Testing view.
export class CeedlingTestController {

    private controller: vscode.TestController | undefined;
    private controllerDisposables: vscode.Disposable[] = [];
    private readonly engine: CeedlingEngine;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly discovery: SingleFlight;
    // Each watcher with its listeners, keyed by what it watches: a configuration file, or a
    // project directory's C sources.
    private readonly configurationWatchers = new Map<string, vscode.Disposable>();
    private readonly sourceWatchers = new Map<string, vscode.Disposable>();
    private readonly editReparses = new Debouncer(EDIT_REPARSE_DELAY_MS);

    private readonly targets = new WeakMap<vscode.TestItem, PlanTarget>();
    // Item ids are unique only within a project, so lookups are scoped by project key.
    private readonly items = new Map<string, Map<string, vscode.TestItem>>();
    private projects: CeedlingProjectNode[] = [];
    private readonly reported = new vscode.EventEmitter<ReportedResult>();
    readonly onDidReport = this.reported.event;
    // A discovery in flight at disposal must not build a TestController or watchers afterwards.
    private disposed = false;

    constructor(
        public readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly logger: Logger,
        isDevelopmentMode: boolean,
        extensionPath: string,
        private label: string,
    ) {
        this.logger.debug(`CeedlingTestController created for ${workspaceFolder.uri.toString()}`);
        this.engine = new CeedlingEngine(workspaceFolder, logger, isDevelopmentMode, {
            configProvider: (uri) => vscode.workspace.getConfiguration('ceedlingExplorer', uri),
            problemMatcher: new ProblemMatcher(logger),
            bundledMixinPath: path.join(extensionPath, 'assets', 'mixins', 'report-tests-log-factory.yml'),
        });
        this.discovery = new SingleFlight(() => this.discover());

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => this.onConfigurationChanged(event)),
            vscode.workspace.onDidChangeTextDocument((event) => this.scheduleReparse(event.document)),
            // Closing a file with unsaved edits discards them, so the saved file is what remains.
            vscode.workspace.onDidCloseTextDocument((document) => void this.reparse(document.uri.fsPath)),
        );

        // Discover now rather than when VS Code first calls resolveHandler, so gutter icons appear
        // in open test files before the Testing view is ever opened.
        void this.refresh();
    }

    setLabel(label: string): void {
        this.label = label;
        if (this.controller) {
            this.controller.label = label;
        }
    }

    // The TestController, while the folder has a Ceedling project.
    get testController(): vscode.TestController | undefined {
        return this.controller;
    }

    // Settles once a discovery started now has finished, whatever its outcome.
    whenDiscovered(): Promise<void> {
        return this.refresh();
    }

    // Runs a request as the Run profile does. A folder without a TestController has nothing to run.
    async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        if (this.controller) {
            await this.handleRun(request, token);
        }
    }

    async clean(): Promise<void> {
        await this.runTask('Clean', (token) => this.engine.clean(token));
    }

    async clobber(): Promise<void> {
        await this.runTask('Clobber', (token) => this.engine.clobber(token));
    }

    dispose(): void {
        this.disposed = true;
        this.logger.debug(`CeedlingTestController disposed for ${this.workspaceFolder.uri.toString()}`);
        this.editReparses.dispose();
        [...this.configurationWatchers.values(), ...this.sourceWatchers.values(), ...this.disposables].forEach((d) => { d.dispose(); });
        this.disposeController();
        this.engine.dispose();
        this.reported.dispose();
    }

    // The TestController, its handlers, and its run profiles, created on first need.
    private ensureController(): vscode.TestController {
        if (this.controller) {
            return this.controller;
        }
        const controller = vscode.tests.createTestController(`ceedlingExplorer:${this.workspaceFolder.uri.toString()}`, this.label);
        controller.resolveHandler = async (item) => {
            if (item === undefined) {
                await this.refresh();
            }
        };
        controller.refreshHandler = () => this.refresh();
        this.controllerDisposables = [
            controller,
            controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.handleRun(request, token), true),
            controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => this.handleDebug(request, token), true),
        ];
        this.controller = controller;
        return controller;
    }

    private disposeController(): void {
        this.controllerDisposables.forEach((d) => { d.dispose(); });
        this.controllerDisposables = [];
        this.controller = undefined;
        this.items.clear();
    }

    private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
        const { clearDiagnostics, rediscoverFor } = settingsChangeEffects(
            (setting) => event.affectsConfiguration(`ceedlingExplorer.${setting}`, this.workspaceFolder.uri),
            () => this.engine.getConfiguration().get<string>('problemMatching.mode', 'disabled'),
        );
        if (clearDiagnostics) {
            this.logger.debug(`onConfigurationChanged: problem matching disabled, clearing diagnostics`);
            this.engine.problemMatcher.clear();
        }
        if (rediscoverFor.length > 0) {
            this.logger.debug(`onConfigurationChanged: ${rediscoverFor.join(', ')} changed, refreshing`);
            void this.refresh();
        }
    }

    private async runTask(name: string, task: (token: vscode.CancellationToken) => Promise<boolean>): Promise<void> {
        this.logger.trace(`${name.toLowerCase()}()`);
        const succeeded = await vscode.window.withProgress(
            { title: `Ceedling ${name}`, cancellable: true, location: vscode.ProgressLocation.Notification },
            (_progress, token) => task(token),
        );
        if (!succeeded) {
            this.logger.showError(`Ceedling ${name.toLowerCase()} failed`);
        }
    }

    private refresh(): Promise<void> {
        return this.discovery.run().catch((e) => this.logger.error(`refresh: ${util.format(e)}`));
    }

    // A folder without a Ceedling project loses its TestController. One whose discovery fails
    // keeps it, emptied, until the next discovery.
    private async discover(): Promise<void> {
        this.logger.trace(`discover()`);
        if (this.disposed) {
            return;
        }
        try {
            this.projects = await this.engine.discover();
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispose() may run during the await
            if (this.disposed) {
                return;
            }
            if (this.projects.length > 0) {
                this.ensureController();
            } else {
                this.disposeController();
            }
        } catch (e) {
            // Disposal stops the engine, which fails a discovery in flight. Nobody is waiting on it.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispose() may run during the await
            if (this.disposed) {
                return;
            }
            const message = e instanceof CeedlingLoadError ? e.message : `Failed to load Ceedling project: ${util.format(e)}`;
            this.logger.error(message);
            vscode.window.showErrorMessage(message);
            this.projects = [];
        }
        this.rebuildTree();
        await this.updateWatchers();
    }

    // Configuration files rediscover everything. C sources in a project directory follow
    // sourceEventEffect.
    private async updateWatchers(): Promise<void> {
        const configurationFiles = new Set(await this.engine.configurationFiles());
        if (this.disposed) {
            return;
        }
        const projectDirectories = new Set(this.projects.map((p) => this.engine.getProjectAbsPath(p.projectKey)));
        this.syncWatchers(this.configurationWatchers, configurationFiles,
            (file) => new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
            (watcher, file) => {
                const changed = () => {
                    this.logger.debug(`watcher: '${file}' changed, refreshing`);
                    void this.refresh();
                };
                return [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];
            });
        this.syncWatchers(this.sourceWatchers, projectDirectories,
            (directory) => new vscode.RelativePattern(vscode.Uri.file(directory), '**/*.c'),
            (watcher) => {
                const onSource = (event: SourceEvent) => (uri: vscode.Uri) => {
                    const effect = sourceEventEffect(event, {
                        isTestFile: () => this.engine.testFileAt(uri.fsPath) !== undefined,
                        mayBeTestFile: () => this.engine.mayBeTestFile(uri.fsPath),
                    });
                    if (effect === 'reparse') void this.reparse(uri.fsPath);
                    else if (effect === 'rediscover') void this.refresh();
                };
                return [watcher.onDidChange(onSource('changed')), watcher.onDidCreate(onSource('created')), watcher.onDidDelete(onSource('deleted'))];
            });
    }

    private syncWatchers(
        watchers: Map<string, vscode.Disposable>, wanted: Set<string>,
        pattern: (key: string) => vscode.RelativePattern,
        listen: (watcher: vscode.FileSystemWatcher, key: string) => vscode.Disposable[],
    ): void {
        const { stale, added } = watcherChanges(watchers.keys(), wanted);
        for (const key of stale) {
            watchers.get(key)?.dispose();
            watchers.delete(key);
        }
        for (const key of added) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern(key));
            watchers.set(key, vscode.Disposable.from(watcher, ...listen(watcher, key)));
        }
    }

    // Reparses an edited test file once typing pauses, from its unsaved contents.
    private scheduleReparse(document: vscode.TextDocument): void {
        const file = document.uri.fsPath;
        if (document.uri.scheme !== 'file' || !this.engine.testFileAt(file)) {
            return;
        }
        this.editReparses.schedule(file, () => void this.reparse(file, document.getText()));
    }

    // Replaces one test file's functions and cases in the tree, without running Ceedling. Watchers
    // and editor events start it without awaiting, so it reports its own failures.
    private async reparse(absPath: string, source?: string): Promise<void> {
        try {
            await this.replaceFileItems(absPath, source);
        } catch (e) {
            this.logger.error(`reparse: '${absPath}' failed: ${util.format(e)}`);
        }
    }

    private async replaceFileItems(absPath: string, source?: string): Promise<void> {
        const found = this.engine.testFileAt(absPath);
        const file = found && await this.engine.rediscoverFile(found.projectKey, found.fileId, source);
        const projectItems = found && this.items.get(found.projectKey);
        const fileItem = file && projectItems?.get(file.id);
        const controller = this.controller;
        if (!found || !file || !projectItems || !fileItem || !controller) {
            return;
        }
        const project = this.projects.find((p) => p.projectKey === found.projectKey);
        if (project) {
            project.files = project.files.map((f) => f.id === file.id ? file : f);
        }
        for (const id of [...projectItems.keys()]) {
            if (id.startsWith(`${file.id}::`)) projectItems.delete(id);
        }
        const uri = vscode.Uri.file(file.absPath);
        fileItem.label = file.label;
        fileItem.children.replace(file.functions.map((fn) => this.buildFunctionItem(controller, found.projectKey, file, fn, uri, projectItems)));
        this.logger.trace(`reparse: '${absPath}' -> ${file.functions.length} function(s)`);
    }

    private rebuildTree(): void {
        this.items.clear();
        const controller = this.controller;
        if (!controller) {
            return;
        }
        const multiProject = this.projects.length > 1;
        const rootItems: vscode.TestItem[] = [];
        for (const project of this.projects) {
            const projectItems = new Map<string, vscode.TestItem>();
            this.items.set(project.projectKey, projectItems);
            const fileItems = project.files.map((file) => this.buildFileItem(controller, project.projectKey, file, projectItems));
            if (multiProject) {
                const projectItem = controller.createTestItem(project.projectKey, project.label);
                projectItem.children.replace(fileItems);
                this.targets.set(projectItem, { kind: 'project', projectKey: project.projectKey });
                rootItems.push(projectItem);
            } else {
                rootItems.push(...fileItems);
            }
        }
        controller.items.replace(rootItems);
        this.logger.debug(`rebuildTree: ${this.projects.length} project(s)`);
    }

    private buildFileItem(
        controller: vscode.TestController, projectKey: string, file: CeedlingFileNode, projectItems: Map<string, vscode.TestItem>,
    ): vscode.TestItem {
        const uri = vscode.Uri.file(file.absPath);
        const fileItem = controller.createTestItem(file.id, file.label, uri);
        this.targets.set(fileItem, { kind: 'file', projectKey, fileId: file.id });
        projectItems.set(file.id, fileItem);
        fileItem.children.replace(file.functions.map((fn) => this.buildFunctionItem(controller, projectKey, file, fn, uri, projectItems)));
        return fileItem;
    }

    private buildFunctionItem(
        controller: vscode.TestController, projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction, uri: vscode.Uri,
        projectItems: Map<string, vscode.TestItem>,
    ): vscode.TestItem {
        const item = controller.createTestItem(fn.id, fn.label, uri);
        item.range = new vscode.Range(fn.line, 0, fn.line, 0);
        this.targets.set(item, { kind: 'function', projectKey, fileId: file.id, functionId: fn.id });
        projectItems.set(fn.id, item);
        item.children.replace(fn.cases.map((testCase) => {
            const caseItem = controller.createTestItem(testCase.id, testCase.label, uri);
            caseItem.range = new vscode.Range(testCase.line, 0, testCase.line, 0);
            this.targets.set(caseItem, { kind: 'case', projectKey, fileId: file.id, functionId: fn.id, caseId: testCase.id });
            projectItems.set(testCase.id, caseItem);
            return caseItem;
        }));
        return item;
    }

    private planFor(request: vscode.TestRunRequest): RunPlanEntry[] {
        const toTargets = (items: readonly vscode.TestItem[]) => items.flatMap((item) => {
            const target = this.targets.get(item);
            if (!target) {
                this.logger.warn(`planFor: no target for TestItem '${item.id}', skipping`);
            }
            return target ? [target] : [];
        });
        return buildRunPlan(this.projects, request.include && toTargets(request.include), toTargets(request.exclude ?? []));
    }

    // Every item an entry runs, for marking them enqueued before any of them starts.
    private itemsOf(entry: RunPlanEntry): vscode.TestItem[] {
        const items = this.items.get(entry.projectKey);
        const roots = entry.kind === 'project' ? entry.files.map((f) => items?.get(f.id))
            : entry.kind === 'file' ? [items?.get(entry.file.id)]
                : [items?.get(entry.fn.id)];
        const all: vscode.TestItem[] = [];
        const collect = (item: vscode.TestItem | undefined) => {
            if (!item) return;
            all.push(item);
            item.children.forEach(collect);
        };
        roots.forEach(collect);
        return all;
    }

    // Excluded items and everything beneath them. A run that can't leave them out of what
    // Ceedling runs, such as one case of a function, still reports nothing for them.
    private excludedItems(request: vscode.TestRunRequest): Set<vscode.TestItem> {
        const excluded = new Set<vscode.TestItem>();
        const collect = (item: vscode.TestItem) => {
            excluded.add(item);
            item.children.forEach(collect);
        };
        (request.exclude ?? []).forEach(collect);
        return excluded;
    }

    private makeReporter(run: vscode.TestRun, projectKey: string, excluded: Set<vscode.TestItem>): RunReporter {
        const items = this.items.get(projectKey);
        return createRunReporter<vscode.TestItem>({
            sink: {
                started: (item) => { run.started(item); this.reported.fire({ item, outcome: 'started' }); },
                passed: (item) => { run.passed(item); this.reported.fire({ item, outcome: 'passed' }); },
                failed: (item, message) => {
                    const shown = testMessage(message, item);
                    run.failed(item, shown);
                    this.reported.fire({ item, outcome: 'failed', message: shown });
                },
                skipped: (item) => { run.skipped(item); this.reported.fire({ item, outcome: 'skipped' }); },
                errored: (item, message) => {
                    const shown = testMessage(message, item);
                    run.errored(item, shown);
                    this.reported.fire({ item, outcome: 'errored', message: shown });
                },
                appendOutput: (text) => { run.appendOutput(text); },
            },
            projectKey,
            find: (id) => items?.get(id),
            excluded: (item) => excluded.has(item),
            projectAbsPath: () => this.engine.getProjectAbsPath(projectKey),
            warn: (message) => { this.logger.warn(message); },
        });
    }

    // Cancellation reaches Ceedling through `token`, which stops only this run's processes.
    private async handleRun(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        const run = this.ensureController().createTestRun(request);
        try {
            const plan = this.planFor(request);
            const excluded = this.excludedItems(request);
            this.logger.debug(`handleRun: plan has ${plan.length} entr${plan.length === 1 ? 'y' : 'ies'}`);
            for (const item of plan.flatMap((entry) => this.itemsOf(entry))) {
                if (!excluded.has(item)) run.enqueued(item);
            }
            // Entries run one at a time, in tree order, so results arrive in a predictable order. The
            // engine alone would let runs in separate project directories overlap.
            /* eslint-disable no-await-in-loop -- sequential by design, see above */
            for (const entry of plan) {
                if (token.isCancellationRequested) break;
                const reporter = this.makeReporter(run, entry.projectKey, excluded);
                if (entry.kind === 'project') {
                    await this.engine.runProjectAll(entry.projectKey, entry.files, reporter, token);
                } else if (entry.kind === 'function') {
                    await this.engine.runFunction(entry.projectKey, entry.file, entry.fn, reporter, token);
                } else {
                    await this.engine.runFile(entry.projectKey, entry.file, reporter, token);
                }
            }
            /* eslint-enable no-await-in-loop */
        } catch (e) {
            this.logger.error(`handleRun error: ${util.format(e)}`);
        } finally {
            run.end();
        }
    }

    // Debugs one test file. Ceedling builds a whole file into one executable, so a request
    // naming several files debugs the first and says so. The build also runs the file's tests,
    // whose real results are reported before the debugger starts.
    private async handleDebug(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        const run = this.ensureController().createTestRun(request);
        const listeners: vscode.Disposable[] = [];
        try {
            const target = debugTarget(this.planFor(request));
            if (!target) {
                this.logger.debug(`handleDebug: nothing to debug`);
                return;
            }
            const { file } = target;
            if (target.severalFiles) {
                vscode.window.showInformationMessage(`Debugging ${file.id} only. Ceedling debugs one test file at a time.`);
            }

            const reporter = this.makeReporter(run, file.projectKey, this.excludedItems(request));
            const executableSubpath = await this.engine.compileForDebug(file.projectKey, file, reporter, token);
            if (executableSubpath === undefined || token.isCancellationRequested) {
                this.logger.debug(`handleDebug: build failed or cancelled for ${file.id}, not starting the debugger`);
                return;
            }

            const debugLaunchConfig = this.engine.getDebugLaunchConfig(file.projectKey);
            const config = this.resolveLaunchConfig(debugLaunchConfig, executableSubpath);
            if (!config) {
                this.logger.warn(`handleDebug: no debug configuration named '${debugLaunchConfig}' in launch.json`);
                vscode.window.showErrorMessage(`No debug configuration named '${debugLaunchConfig}' found in launch.json.`);
                return;
            }

            const requestId = crypto.randomUUID();
            config[DEBUG_REQUEST_KEY] = requestId;
            let session: vscode.DebugSession | undefined;
            const terminated = new Promise<void>((resolve) => {
                listeners.push(
                    vscode.debug.onDidStartDebugSession((started) => {
                        if (started.configuration[DEBUG_REQUEST_KEY] === requestId) session = started;
                    }),
                    vscode.debug.onDidTerminateDebugSession((ended) => {
                        if (ended.configuration[DEBUG_REQUEST_KEY] === requestId) resolve();
                    }),
                    token.onCancellationRequested(() => {
                        if (session) vscode.debug.stopDebugging(session);
                        resolve();
                    }),
                );
            });
            if (!await vscode.debug.startDebugging(this.workspaceFolder, config)) {
                this.logger.warn(`handleDebug: vscode.debug.startDebugging returned false for '${config.name}'`);
                vscode.window.showErrorMessage(`The debugger could not be started with '${config.name}'. Check ceedlingExplorer.projects and launch.json.`);
                return;
            }
            this.logger.debug(`handleDebug: debug session '${config.name}' started`);
            await terminated;
        } catch (e) {
            this.logger.error(`Debug error: ${util.format(e)}`);
        } finally {
            listeners.forEach((listener) => { listener.dispose(); });
            run.end();
        }
    }

    // The named launch.json configuration, debugging the built test executable.
    private resolveLaunchConfig(debugLaunchConfig: string, executableSubpath: string): vscode.DebugConfiguration | undefined {
        const configurations = vscode.workspace
            .getConfiguration('launch', this.workspaceFolder.uri)
            .get<vscode.DebugConfiguration[]>('configurations', []);
        const config = resolveLaunchConfig(configurations, debugLaunchConfig, executableSubpath);
        this.logger.debug(config
            ? `resolveLaunchConfig: resolved '${debugLaunchConfig}' with executableSubpath='${executableSubpath}'`
            : `resolveLaunchConfig: '${debugLaunchConfig}' not found among ${configurations.length} launch.json configuration(s)`);
        return config;
    }
}

// A reported message as the Testing view shows it: a gdb log as a link, a location as a place in
// the editor, by default in the test's own file.
function testMessage(message: ReportMessage, item: vscode.TestItem): vscode.TestMessage {
    const shown = message.log
        ? new vscode.TestMessage(new vscode.MarkdownString(`${message.text}\n\n[${message.log.label}](${vscode.Uri.file(message.log.absPath).toString()})`))
        : new vscode.TestMessage(message.text);
    const uri = message.location?.file !== undefined ? vscode.Uri.file(message.location.file) : item.uri;
    if (message.location && uri) {
        shown.location = new vscode.Location(uri, new vscode.Position(message.location.line, 0));
    }
    return shown;
}
