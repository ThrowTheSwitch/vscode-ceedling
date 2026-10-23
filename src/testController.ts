import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import util from 'util';
import vscode from 'vscode';
import { CeedlingEngine, CeedlingLoadError } from './ceedlingEngine';
import { extractGdbLogReference } from './ceedlingOutputParsing';
import { Logger } from './logger';
import { ProblemMatcher } from './problemMatcher';
import { buildRunPlan, PlanTarget, RunPlanEntry } from './runPlan';
import { CeedlingFileNode, CeedlingProjectNode, CeedlingTestFunction, RunReporter } from './testModel';

// Names the launch configuration of one debug request, so its debug session can be told apart
// from any other session VS Code starts meanwhile.
const DEBUG_REQUEST_KEY = '__ceedlingDebugRequest';

// Owns one native vscode.TestController for a workspace folder, mirroring CeedlingEngine's
// discovery and results onto TestItems and TestRuns. Several Ceedling projects in one folder
// (ceedlingExplorer.projects) appear as sibling root items.
export class CeedlingTestController {

    private readonly controller: vscode.TestController;
    private readonly engine: CeedlingEngine;
    private readonly disposables: vscode.Disposable[] = [];

    private readonly targets = new WeakMap<vscode.TestItem, PlanTarget>();
    // Item ids are unique only within a project, so lookups are scoped by project key.
    private readonly items = new Map<string, Map<string, vscode.TestItem>>();
    private readonly watchedReloadFiles = new Set<string>();
    private projects: CeedlingProjectNode[] = [];

    constructor(
        public readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly logger: Logger,
        isDevelopmentMode: boolean,
        extensionPath: string,
    ) {
        this.logger.debug(`CeedlingTestController created for ${workspaceFolder.uri.toString()}`);
        this.engine = new CeedlingEngine(workspaceFolder, logger, isDevelopmentMode, {
            configProvider: (uri) => vscode.workspace.getConfiguration('ceedlingExplorer', uri),
            problemMatcher: new ProblemMatcher(logger),
            bundledMixinPath: path.join(extensionPath, 'assets', 'mixins', 'report-tests-log-factory.yml'),
        });
        this.controller = vscode.tests.createTestController(`ceedlingExplorer:${workspaceFolder.uri.toString()}`, 'Ceedling');
        this.disposables.push(this.controller);

        this.controller.resolveHandler = async (item) => {
            if (item === undefined) {
                await this.refresh();
            }
        };
        this.controller.refreshHandler = async () => {
            await this.refresh();
        };

        this.disposables.push(
            this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.handleRun(request, token), true),
            this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => this.handleDebug(request, token), true),
        );

        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("ceedlingExplorer.problemMatching", this.workspaceFolder.uri)) {
                if (!this.engine.getConfiguration().get<boolean>('problemMatching.enabled', false)) {
                    this.logger.debug(`onDidChangeConfiguration: problemMatching disabled, clearing diagnostics`);
                    this.engine.problemMatcher.clear();
                }
            }
            const pathChanged = event.affectsConfiguration("ceedlingExplorer.projects", this.workspaceFolder.uri);
            const affectedPrettyTestLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestLabel", this.workspaceFolder.uri);
            const affectedPrettyTestFileLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestFileLabel", this.workspaceFolder.uri);
            if (affectedPrettyTestLabel || affectedPrettyTestFileLabel || pathChanged) {
                this.logger.debug(`onDidChangeConfiguration: projects=${pathChanged}, prettyTestLabel=${affectedPrettyTestLabel}, ` +
                    `prettyTestFileLabel=${affectedPrettyTestFileLabel}, refreshing`);
                this.refresh();
            }
        }));

        // Populate now rather than when VS Code first calls resolveHandler, so gutter icons appear
        // in open test files before the Testing view is ever opened.
        this.refresh();
    }

    async clean(): Promise<void> {
        await this.runTask('Clean', (token) => this.engine.clean(token));
    }

    async clobber(): Promise<void> {
        await this.runTask('Clobber', (token) => this.engine.clobber(token));
    }

    dispose(): void {
        this.logger.debug(`CeedlingTestController disposed for ${this.workspaceFolder.uri.toString()}`);
        for (const file of this.watchedReloadFiles) {
            fs.unwatchFile(file);
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.engine.dispose();
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

    private async refresh(): Promise<void> {
        this.logger.trace(`refresh()`);
        try {
            this.projects = await this.engine.discover();
        } catch (e) {
            const message = e instanceof CeedlingLoadError ? e.message : `Failed to load Ceedling project: ${util.format(e)}`;
            this.logger.error(message);
            vscode.window.showErrorMessage(message);
            this.projects = [];
        }
        this.rebuildTree();
        this.watchFilesForReload(this.engine.getYmlProjectPaths());
    }

    private rebuildTree(): void {
        this.items.clear();
        const multiProject = this.projects.length > 1;
        const rootItems: vscode.TestItem[] = [];
        for (const project of this.projects) {
            const projectItems = new Map<string, vscode.TestItem>();
            this.items.set(project.projectKey, projectItems);
            const fileItems = project.files.map((file) => this.buildFileItem(project.projectKey, file, projectItems));
            if (multiProject) {
                const projectItem = this.controller.createTestItem(project.projectKey, project.label);
                projectItem.children.replace(fileItems);
                this.targets.set(projectItem, { kind: 'project', projectKey: project.projectKey });
                rootItems.push(projectItem);
            } else {
                rootItems.push(...fileItems);
            }
        }
        this.controller.items.replace(rootItems);
        this.logger.debug(`rebuildTree: ${this.projects.length} project(s)`);
    }

    private buildFileItem(projectKey: string, file: CeedlingFileNode, projectItems: Map<string, vscode.TestItem>): vscode.TestItem {
        const uri = vscode.Uri.file(file.absPath);
        const fileItem = this.controller.createTestItem(file.id, file.label, uri);
        this.targets.set(fileItem, { kind: 'file', projectKey, fileId: file.id });
        projectItems.set(file.id, fileItem);
        fileItem.children.replace(file.functions.map((fn) => this.buildFunctionItem(projectKey, file, fn, uri, projectItems)));
        return fileItem;
    }

    private buildFunctionItem(
        projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction, uri: vscode.Uri, projectItems: Map<string, vscode.TestItem>,
    ): vscode.TestItem {
        const item = this.controller.createTestItem(fn.id, fn.label, uri);
        item.range = new vscode.Range(fn.line, 0, fn.line, 0);
        this.targets.set(item, { kind: 'function', projectKey, fileId: file.id, functionId: fn.id });
        projectItems.set(fn.id, item);
        item.children.replace(fn.cases.map((testCase) => {
            const caseItem = this.controller.createTestItem(testCase.id, testCase.label, uri);
            caseItem.range = new vscode.Range(testCase.line, 0, testCase.line, 0);
            this.targets.set(caseItem, { kind: 'case', projectKey, fileId: file.id, functionId: fn.id, caseId: testCase.id });
            projectItems.set(testCase.id, caseItem);
            return caseItem;
        }));
        return item;
    }

    private watchFilesForReload(files: string[]): void {
        for (const file of files) {
            if (!this.watchedReloadFiles.has(file)) {
                this.watchedReloadFiles.add(file);
                fs.watchFile(file, () => {
                    this.logger.debug(`watchFilesForReload: '${file}' changed, refreshing`);
                    this.refresh();
                });
            }
        }
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
        const run = this.controller.createTestRun(request);
        try {
            const plan = this.planFor(request);
            const excluded = this.excludedItems(request);
            this.logger.debug(`handleRun: plan has ${plan.length} entr${plan.length === 1 ? 'y' : 'ies'}`);
            for (const item of plan.flatMap((entry) => this.itemsOf(entry))) {
                if (!excluded.has(item)) run.enqueued(item);
            }
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
        const run = this.controller.createTestRun(request);
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
            listeners.forEach((listener) => listener.dispose());
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
        );
    }
}
