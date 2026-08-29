import fs from 'fs';
import util from 'util';
import vscode from 'vscode';
import {
    CeedlingEngine,
    CeedlingFileNode,
    CeedlingLoadError,
    CeedlingProjectNode,
    CeedlingTestFunction,
    RunReporter,
} from './ceedlingEngine';
import { Logger } from './logger';

type ItemMeta =
    | { kind: 'project', projectKey: string }
    | { kind: 'file' | 'function' | 'case', projectKey: string, file: CeedlingFileNode };

type RunPlanEntry =
    | { kind: 'project', projectKey: string, files: CeedlingFileNode[] }
    | { kind: 'file', projectKey: string, file: CeedlingFileNode };

// Owns one native vscode.TestController for a workspace folder, mirroring the CeedlingEngine's
// discovery/run output onto TestItem/TestRun. One controller may show multiple Ceedling projects
// (ceedlingExplorer.projects) as sibling roots.
export class CeedlingTestController {

    private readonly controller: vscode.TestController;
    private readonly engine: CeedlingEngine;
    private readonly disposables: vscode.Disposable[] = [];

    private readonly itemMeta = new WeakMap<vscode.TestItem, ItemMeta>();
    private readonly idToItem = new Map<string, vscode.TestItem>();
    private readonly watchedReloadFiles = new Set<string>();
    private projects: CeedlingProjectNode[] = [];

    private activeDebugSession: vscode.DebugSession | undefined;

    constructor(
        public readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly logger: Logger,
        private readonly isDevelopmentMode: boolean,
    ) {
        this.logger.debug(`CeedlingTestController created for ${workspaceFolder.uri.toString()}`);
        this.engine = new CeedlingEngine(workspaceFolder, logger, isDevelopmentMode);
        this.controller = vscode.tests.createTestController(
            `ceedlingExplorer:${workspaceFolder.uri.toString()}`,
            'Ceedling',
        );
        this.disposables.push(this.controller);

        this.controller.resolveHandler = async (item) => {
            if (item === undefined) {
                await this.refresh();
            }
        };
        this.controller.refreshHandler = async () => {
            await this.refresh();
        };

        const runProfile = this.controller.createRunProfile(
            'Run', vscode.TestRunProfileKind.Run,
            (request, token) => this.handleRun(request, token), true,
        );
        const debugProfile = this.controller.createRunProfile(
            'Debug', vscode.TestRunProfileKind.Debug,
            (request, token) => this.handleDebug(request, token), true,
        );
        this.disposables.push(runProfile, debugProfile);

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

        // Proactively populate on creation instead of waiting for VS Code to call
        // resolveHandler, so the tree isn't empty until the user expands something.
        this.refresh();
    }

    async clean(): Promise<void> {
        this.logger.trace(`clean()`);
        const results = await vscode.window.withProgress(
            { title: "Ceedling Clean", cancellable: true, location: vscode.ProgressLocation.Notification },
            async (_progress, token) => {
                token.onCancellationRequested(() => this.engine.cancel());
                return this.engine.clean();
            }
        );
        if (results.some((x) => x.error)) {
            this.logger.showError("Ceedling clean failed");
        }
    }

    async clobber(): Promise<void> {
        this.logger.trace(`clobber()`);
        const results = await vscode.window.withProgress(
            { title: "Ceedling Clobber", cancellable: true, location: vscode.ProgressLocation.Notification },
            async (_progress, token) => {
                token.onCancellationRequested(() => this.engine.cancel());
                return this.engine.clobber();
            }
        );
        if (results.some((x) => x.error)) {
            this.logger.showError("Ceedling clobber failed");
        }
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
        this.idToItem.clear();
        const multiProject = this.projects.length > 1;
        const rootItems: vscode.TestItem[] = [];
        for (const project of this.projects) {
            const fileItems = project.files.map((file) => this.buildFileItem(project.projectKey, file));
            if (multiProject) {
                const projectItem = this.controller.createTestItem(project.projectKey, project.label);
                projectItem.children.replace(fileItems);
                this.itemMeta.set(projectItem, { kind: 'project', projectKey: project.projectKey });
                rootItems.push(projectItem);
            } else {
                rootItems.push(...fileItems);
            }
        }
        this.controller.items.replace(rootItems);
        this.logger.debug(`rebuildTree: ${this.projects.length} project(s), ${this.idToItem.size} file/function/case item(s)`);
    }

    private buildFileItem(projectKey: string, file: CeedlingFileNode): vscode.TestItem {
        const uri = vscode.Uri.file(file.absPath);
        const fileItem = this.controller.createTestItem(file.id, file.label, uri);
        this.itemMeta.set(fileItem, { kind: 'file', projectKey, file });
        this.idToItem.set(file.id, fileItem);
        fileItem.children.replace(file.functions.map((fn) => this.buildFunctionItem(projectKey, file, fn, uri)));
        return fileItem;
    }

    private buildFunctionItem(projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction, uri: vscode.Uri): vscode.TestItem {
        const item = this.controller.createTestItem(fn.id, fn.label, uri);
        item.range = new vscode.Range(fn.line, 0, fn.line, 0);
        this.itemMeta.set(item, { kind: 'function', projectKey, file });
        this.idToItem.set(fn.id, item);
        if (fn.cases.length > 0) {
            item.children.replace(fn.cases.map((testCase) => {
                const caseItem = this.controller.createTestItem(testCase.id, testCase.label, uri);
                caseItem.range = new vscode.Range(testCase.line, 0, testCase.line, 0);
                this.itemMeta.set(caseItem, { kind: 'case', projectKey, file });
                this.idToItem.set(testCase.id, caseItem);
                return caseItem;
            }));
        }
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

    // Ceedling only ever runs/compiles a whole test file at a time, so every requested item
    // (project, file, parametrized-function, or individual case) resolves up to its file here.
    private buildRunPlan(include: readonly vscode.TestItem[] | undefined): RunPlanEntry[] {
        const plan: RunPlanEntry[] = [];
        const seenFiles = new Set<string>();
        const seenProjects = new Set<string>();

        const addFile = (projectKey: string, file: CeedlingFileNode) => {
            const key = `${projectKey}::${file.id}`;
            if (seenFiles.has(key)) return;
            seenFiles.add(key);
            plan.push({ kind: 'file', projectKey, file });
        };
        const addProject = (projectKey: string, files: CeedlingFileNode[]) => {
            if (seenProjects.has(projectKey)) return;
            seenProjects.add(projectKey);
            plan.push({ kind: 'project', projectKey, files });
        };

        if (include === undefined) {
            // Run everything: always per-file, never the bulk "test:all" shortcut, which is only
            // used when a project-level node is explicitly targeted (see addProject below).
            for (const project of this.projects) {
                for (const file of project.files) {
                    addFile(project.projectKey, file);
                }
            }
            return plan;
        }

        for (const item of include) {
            const meta = this.itemMeta.get(item);
            if (!meta) {
                this.logger.warn(`buildRunPlan: no metadata for requested TestItem '${item.id}', skipping`);
                continue;
            }
            if (meta.kind === 'project') {
                const project = this.projects.find((p) => p.projectKey === meta.projectKey);
                if (project) addProject(meta.projectKey, project.files);
            } else {
                addFile(meta.projectKey, meta.file);
            }
        }
        return plan;
    }

    private makeReporter(run: vscode.TestRun): RunReporter {
        const warnUnmapped = (callback: string, id: string) => {
            this.logger.warn(`makeReporter.${callback}: no TestItem found for id '${id}', dropping this result`);
        };
        return {
            started: (id) => {
                const item = this.idToItem.get(id);
                if (item) run.started(item); else warnUnmapped('started', id);
            },
            passed: (id) => {
                const item = this.idToItem.get(id);
                if (item) run.passed(item); else warnUnmapped('passed', id);
            },
            failed: (id, message, line) => {
                const item = this.idToItem.get(id);
                if (!item) { warnUnmapped('failed', id); return; }
                const testMessage = new vscode.TestMessage(message);
                if (line !== undefined && item.uri) {
                    testMessage.location = new vscode.Location(item.uri, new vscode.Position(line, 0));
                }
                run.failed(item, testMessage);
            },
            skipped: (id) => {
                const item = this.idToItem.get(id);
                if (item) run.skipped(item); else warnUnmapped('skipped', id);
            },
            errored: (id, message) => {
                const item = this.idToItem.get(id);
                if (item) run.errored(item, new vscode.TestMessage(message)); else warnUnmapped('errored', id);
            },
            appendOutput: (text) => run.appendOutput(text),
        };
    }

    private async handleRun(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        const run = this.controller.createTestRun(request);
        token.onCancellationRequested(() => this.engine.cancel());
        const reporter = this.makeReporter(run);
        try {
            const plan = this.buildRunPlan(request.include);
            this.logger.debug(`handleRun: starting, plan has ${plan.length} entr${plan.length === 1 ? 'y' : 'ies'}`);
            for (const entry of plan) {
                if (token.isCancellationRequested) break;
                if (entry.kind === 'project') {
                    await this.engine.runProjectAll(entry.projectKey, entry.files, reporter, token);
                } else {
                    await this.engine.runFile(entry.projectKey, entry.file, reporter, token);
                }
            }
        } catch (e) {
            this.logger.error(`handleRun error: ${util.format(e)}`);
        } finally {
            this.logger.debug(`handleRun: done`);
            run.end();
        }
    }

    private async handleDebug(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        const run = this.controller.createTestRun(request);
        token.onCancellationRequested(() => {
            this.engine.cancel();
            if (this.activeDebugSession) {
                vscode.debug.stopDebugging(this.activeDebugSession);
            }
        });
        try {
            // Only whole-file debugging is supported (Ceedling always builds/runs a whole test
            // file's executable) - if multiple items are targeted, debug just the first.
            const plan = this.buildRunPlan(request.include);
            const first = plan[0];
            if (!first) {
                this.logger.debug(`handleDebug: empty run plan, nothing to debug`);
                return;
            }
            const { projectKey, file } = first.kind === 'project'
                ? { projectKey: first.projectKey, file: first.files[0] }
                : first;
            if (!file) {
                this.logger.debug(`handleDebug: no file resolved from plan entry (project=${projectKey})`);
                return;
            }

            const reporter = this.makeReporter(run);
            const executableSubpath = await this.engine.compileForDebug(projectKey, file, reporter);
            if (executableSubpath === undefined || token.isCancellationRequested) {
                this.logger.debug(`handleDebug: compile failed or cancelled for ${file.id}, not starting debugger`);
                return;
            }

            const debugLaunchConfig = this.engine.getDebugLaunchConfig(projectKey);
            const resolvedConfig = this.resolveLaunchConfig(debugLaunchConfig, executableSubpath);
            if (!resolvedConfig) {
                this.logger.warn(`handleDebug: no debug configuration named '${debugLaunchConfig}' found in launch.json`);
                reporter.failed(file.id, `No debug configuration named '${debugLaunchConfig}' found in launch.json.`);
                return;
            }

            const terminated = new Promise<void>((resolve) => {
                const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
                    if (session.name === resolvedConfig.name) {
                        this.logger.debug(`handleDebug: debug session '${session.name}' terminated`);
                        this.activeDebugSession = undefined;
                        disposable.dispose();
                        resolve();
                    }
                });
            });

            const started = await vscode.debug.startDebugging(this.workspaceFolder, resolvedConfig);
            if (!started) {
                this.logger.warn(`handleDebug: vscode.debug.startDebugging returned false for config '${resolvedConfig.name}'`);
                reporter.failed(file.id, 'Debugger could not be started. Check your ceedlingExplorer.projects parameter in settings.');
                return;
            }
            this.activeDebugSession = vscode.debug.activeDebugSession;
            this.logger.debug(`handleDebug: debug session '${resolvedConfig.name}' started`);
            await terminated;
            reporter.passed(file.id);
        } catch (e) {
            this.logger.error(`Debug error: ${util.format(e)}`);
        } finally {
            run.end();
        }
    }

    // Splices the resolved test executable's relative path into every occurrence of
    // ${command:ceedlingExplorer.debugTestExecutable} in the user's named launch.json
    // configuration, so debugging no longer depends on VS Code resolving a registered command
    // against extension-held mutable state at an unpredictable time (the root cause behind
    // issue #2's "wrong executable" reports).
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
            JSON.stringify(found).replace(/\$\{command:ceedlingExplorer\.debugTestExecutable\}/g, executableSubpath)
        );
    }
}
