import crypto from 'crypto';
import path from 'path';
import util from 'util';
import vscode from 'vscode';
import { CeedlingEngine, CeedlingLoadError } from './ceedlingEngine';
import { extractGdbLogReference } from './ceedlingOutputParsing';
import { type Logger } from './logger';
import { ProblemMatcher } from './problemMatcher';
import { buildRunPlan, type PlanTarget, type RunPlanEntry } from './runPlan';
import { SingleFlight } from './singleFlight';
import { type CeedlingFileNode, type CeedlingProjectNode, type CeedlingTestFunction, type RunReporter } from './testModel';

// Names the launch configuration of one debug request, so its debug session can be told apart
// from any other session VS Code starts meanwhile.
const DEBUG_REQUEST_KEY = '__ceedlingDebugRequest';
// Settings whose change changes what discovery finds. The rest apply on the next run.
const DISCOVERY_SETTINGS = ['projects', 'mixins', 'shellPath', 'ceedlingCommand', 'prettyTestLabel', 'prettyTestFileLabel'];
// How long typing pauses before an unsaved test file is reparsed.
const EDIT_REPARSE_DELAY_MS = 400;

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
    private readonly pendingReparses = new Map<string, NodeJS.Timeout>();

    private readonly targets = new WeakMap<vscode.TestItem, PlanTarget>();
    // Item ids are unique only within a project, so lookups are scoped by project key.
    private readonly items = new Map<string, Map<string, vscode.TestItem>>();
    private projects: CeedlingProjectNode[] = [];

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

    async clean(): Promise<void> {
        await this.runTask('Clean', (token) => this.engine.clean(token));
    }

    async clobber(): Promise<void> {
        await this.runTask('Clobber', (token) => this.engine.clobber(token));
    }

    dispose(): void {
        this.logger.debug(`CeedlingTestController disposed for ${this.workspaceFolder.uri.toString()}`);
        this.pendingReparses.forEach((timer) => clearTimeout(timer));
        [...this.configurationWatchers.values(), ...this.sourceWatchers.values(), ...this.disposables].forEach((d) => { d.dispose(); });
        this.disposeController();
        this.engine.dispose();
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
        const affects = (setting: string) => event.affectsConfiguration(`ceedlingExplorer.${setting}`, this.workspaceFolder.uri);
        if (affects('problemMatching') && this.engine.getConfiguration().get<string>('problemMatching.mode', 'disabled') === 'disabled') {
            this.logger.debug(`onConfigurationChanged: problem matching disabled, clearing diagnostics`);
            this.engine.problemMatcher.clear();
        }
        const changed = DISCOVERY_SETTINGS.filter(affects);
        if (changed.length > 0) {
            this.logger.debug(`onConfigurationChanged: ${changed.join(', ')} changed, refreshing`);
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
        try {
            this.projects = await this.engine.discover();
            if (this.projects.length > 0) {
                this.ensureController();
            } else {
                this.disposeController();
            }
        } catch (e) {
            const message = e instanceof CeedlingLoadError ? e.message : `Failed to load Ceedling project: ${util.format(e)}`;
            this.logger.error(message);
            vscode.window.showErrorMessage(message);
            this.projects = [];
        }
        this.rebuildTree();
        await this.updateWatchers();
    }

    // Configuration files rediscover everything. A C source change in a project directory
    // reparses that test file alone. A test file appearing or disappearing rediscovers, since only
    // `ceedling files:test` knows the full list.
    private async updateWatchers(): Promise<void> {
        const configurationFiles = new Set(await this.engine.configurationFiles());
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
            (watcher) => [
                watcher.onDidChange((uri) => void this.reparse(uri.fsPath)),
                watcher.onDidCreate((uri) => {
                    if (this.engine.mayBeTestFile(uri.fsPath)) void this.refresh();
                }),
                watcher.onDidDelete((uri) => {
                    if (this.engine.testFileAt(uri.fsPath)) void this.refresh();
                }),
            ]);
    }

    private syncWatchers(
        watchers: Map<string, vscode.Disposable>, wanted: Set<string>,
        pattern: (key: string) => vscode.RelativePattern,
        listen: (watcher: vscode.FileSystemWatcher, key: string) => vscode.Disposable[],
    ): void {
        for (const [key, watcher] of watchers) {
            if (!wanted.has(key)) {
                watcher.dispose();
                watchers.delete(key);
            }
        }
        for (const key of wanted) {
            if (!watchers.has(key)) {
                const watcher = vscode.workspace.createFileSystemWatcher(pattern(key));
                watchers.set(key, vscode.Disposable.from(watcher, ...listen(watcher, key)));
            }
        }
    }

    // Reparses an edited test file once typing pauses, from its unsaved contents.
    private scheduleReparse(document: vscode.TextDocument): void {
        const file = document.uri.fsPath;
        if (document.uri.scheme !== 'file' || !this.engine.testFileAt(file)) {
            return;
        }
        clearTimeout(this.pendingReparses.get(file));
        this.pendingReparses.set(file, setTimeout(() => {
            this.pendingReparses.delete(file);
            void this.reparse(file, document.getText());
        }, EDIT_REPARSE_DELAY_MS));
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
        const lookup = (callback: string, id: string): vscode.TestItem | undefined => {
            const item = items?.get(id);
            if (!item) {
                this.logger.warn(`makeReporter.${callback}: no TestItem for '${id}' in project '${projectKey}', dropping this result`);
            }
            return item && !excluded.has(item) ? item : undefined;
        };
        return {
            started: (id) => {
                const item = lookup('started', id);
                if (item) run.started(item);
            },
            passed: (id) => {
                const item = lookup('passed', id);
                if (item) run.passed(item);
            },
            failed: (id, message, line) => {
                const item = lookup('failed', id);
                if (!item) return;
                // Ceedling 1.1.0+'s :use_backtrace: :gdb ends a crash message with a gdb log
                // path, relative to the project directory. It becomes a clickable link.
                const { text, logPath } = extractGdbLogReference(message);
                const testMessage = logPath !== undefined
                    ? new vscode.TestMessage(new vscode.MarkdownString(
                        `${text}\n\n[${logPath}](${vscode.Uri.file(path.resolve(this.engine.getProjectAbsPath(projectKey), logPath)).toString()})`
                    ))
                    : new vscode.TestMessage(message);
                if (line !== undefined && item.uri) {
                    testMessage.location = new vscode.Location(item.uri, new vscode.Position(line, 0));
                }
                run.failed(item, testMessage);
            },
            skipped: (id) => {
                const item = lookup('skipped', id);
                if (item) run.skipped(item);
            },
            errored: (id, message, location) => {
                const item = lookup('errored', id);
                if (!item) return;
                const testMessage = new vscode.TestMessage(message);
                if (location) {
                    // The diagnostic's own file, which may be a header rather than the test file.
                    testMessage.location = new vscode.Location(vscode.Uri.file(location.file), new vscode.Position(location.line, 0));
                }
                run.errored(item, testMessage);
            },
            appendOutput: (text) => run.appendOutput(text),
        };
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
            // Entries run one at a time, in tree order. The engine serializes Ceedling runs anyway.
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
            const plan = this.planFor(request);
            const files = plan.flatMap((entry) => entry.kind === 'project' ? entry.files : [entry.file]);
            const file = files[0];
            if (!file) {
                this.logger.debug(`handleDebug: nothing to debug`);
                return;
            }
            if (new Set(files.map((f) => `${f.projectKey}::${f.id}`)).size > 1) {
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

    // Splices the built test executable's relative path into every occurrence of
    // ${command:ceedlingExplorer.debugTestExecutable} in the named launch.json configuration.
    // VS Code never resolves the token itself, so debugging doesn't depend on when it would.
    private resolveLaunchConfig(debugLaunchConfig: string, executableSubpath: string): vscode.DebugConfiguration | undefined {
        const configurations = vscode.workspace
            .getConfiguration('launch', this.workspaceFolder.uri)
            .get<vscode.DebugConfiguration[]>('configurations', []);
        const found = configurations.find((c) => c.name === debugLaunchConfig);
        if (!found) {
            this.logger.debug(`resolveLaunchConfig: '${debugLaunchConfig}' not found among ${configurations.length} launch.json configuration(s)`);
            return undefined;
        }
        this.logger.debug(`resolveLaunchConfig: resolved '${debugLaunchConfig}' with executableSubpath='${executableSubpath}'`);
        return JSON.parse(
            JSON.stringify(found).replace(/\$\{command:ceedlingExplorer\.debugTestExecutable\}/g, () => executableSubpath)
        ) as vscode.DebugConfiguration;
    }
}
