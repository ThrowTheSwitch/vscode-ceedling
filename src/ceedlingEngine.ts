// Orchestrates Ceedling for one workspace folder: discovering its projects and tests, running
// them, building a test for the debugger, and cleaning. Each concern lives in its own module. This
// class sequences them and owns the per-folder state.
//
// - ceedlingProjectConfig: settings → projects, and resolved configuration → ProjectState
// - ceedlingProcess: running Ceedling, with per-run cancellation
// - unityTestDiscovery: test functions and cases in source, named as Ceedling names them
// - testResults: the CppUnit report mapped onto discovered ids
//
// It has no runtime `vscode` dependency. Workspace configuration, the problem matcher, the
// runner, and the filesystem come in through `deps`, so the unit tests drive it with fakes.

import { Mutex } from 'async-mutex';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';
import semver from 'semver';
import util from 'util';
import type vscode from 'vscode';
import { buildProjectArgs } from './ceedlingMixinArgs';
import {
    buildFileLabelRegex,
    buildTestLabelRegex,
    extractTestFunctionName,
    parseCeedlingVersionString,
    parseFileListBullets,
    testCaseFilterMatchedExactly,
} from './ceedlingOutputParsing';
import { buildCommandLine, Cancellation, CeedlingResult, CeedlingRunner } from './ceedlingProcess';
import {
    ALTERNATE_DEFAULT_PROJECT_FILE,
    capabilitiesOf,
    CeedlingCapabilities,
    CeedlingLoadError,
    CeedlingProject,
    DEFAULT_CPPUNIT_REPORT_FILENAME,
    DEFAULT_PROJECT_FILE,
    ProjectSetting,
    ProjectState,
    projectState,
    projectsFromSettings,
} from './ceedlingProjectConfig';
import type { Logger } from './logger';
import type { FileDiagnostic, ProblemMatcher, ProblemMatchingPattern } from './problemMatcher';
import { allIds, CeedlingFileNode, CeedlingProjectNode, CeedlingTestFunction, leafIds, RunReporter } from './testModel';
import { CppUnitReport, parseCppUnitReport, reportedNames, testResults } from './testResults';
import { discoverTests } from './unityTestDiscovery';

export { CeedlingLoadError } from './ceedlingProjectConfig';

const MINIMUM_CEEDLING_VERSION = '1.0.0';
// Added to test runs and debug builds in development mode only, for the extension's own logs.
const DEBUG_VERBOSITY = ['--verbosity', 'debug'];
const UNREPORTED_MESSAGE =
    "Ceedling reported no result for this test. Its name as found in the source may not match the name Ceedling's test runner gave it.";

// The filesystem operations the engine needs. Tests substitute an in-memory implementation.
export interface EngineFileSystem {
    exists(filePath: string): boolean;
    isDirectory(filePath: string): boolean;
    readFile(filePath: string): Promise<string>;
    unlink(filePath: string): Promise<void>;
    // undefined when the file doesn't exist.
    mtimeMs(filePath: string): number | undefined;
}

export const nodeFileSystem: EngineFileSystem = {
    exists: (filePath) => fs.existsSync(filePath),
    isDirectory: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory() ?? false,
    readFile: (filePath) => fs.promises.readFile(filePath, 'utf8'),
    unlink: (filePath) => fs.promises.unlink(filePath),
    mtimeMs: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })?.mtimeMs,
};

export type EngineDeps = {
    configProvider: (uri: vscode.Uri) => vscode.WorkspaceConfiguration,
    problemMatcher: ProblemMatcher,
    // The extension's own mixin enabling the CppUnit report. It is always the last --mixin flag.
    bundledMixinPath: string,
    runner?: CeedlingRunner,
    fileSystem?: EngineFileSystem,
    platform?: NodeJS.Platform,
    tmpdir?: string,
};

type LoadedProject = CeedlingProject & { capabilities: CeedlingCapabilities, state: ProjectState, files: CeedlingFileNode[] };

// What a run compiled. A file run's diagnostics replace only that file's, a project run's all.
type RunScope = { kind: 'project' } | { kind: 'file', file: CeedlingFileNode };

type BuildOutcome =
    | { cancelled: true }
    | { cancelled: false, transcript: string, diagnostics: FileDiagnostic[], report: CppUnitReport | undefined };

// Diagnostics are kept per project for project runs, and per file for file and function runs.
function fileDiagnosticsId(projectKey: string, fileId: string): string {
    return `${projectKey}::${fileId}`;
}

export class CeedlingEngine {

    readonly problemMatcher: ProblemMatcher;

    private readonly configProvider: (uri: vscode.Uri) => vscode.WorkspaceConfiguration;
    private readonly bundledMixinPath: string;
    private readonly runner: CeedlingRunner;
    private readonly fs: EngineFileSystem;
    private readonly platform: NodeJS.Platform;
    // Path rules follow `platform` rather than the host's, as ceedlingProjectConfig's do.
    private readonly paths: typeof path.posix;
    private readonly tmpdir: string;
    // Serializes every Ceedling invocation that builds or deletes in a project's build directory.
    private readonly mutex = new Mutex();

    // The last successful discovery. A failed discovery leaves it in place, so runs already under
    // way, and runs of the tree still on screen, keep their project arguments and directory.
    private projects = new Map<string, LoadedProject>();
    // Projects whose project file exists, as of the latest discovery attempt, failed or not. Their
    // files are watched, so fixing a broken configuration triggers the next discovery.
    private candidates: CeedlingProject[] = [];
    // One notification per project per session. A project.yml save rediscovers every time.
    private readonly warnedNonDefaultReportFilename = new Set<string>();

    constructor(
        public readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly logger: Logger,
        private readonly isDevelopmentMode: boolean,
        deps: EngineDeps,
    ) {
        this.configProvider = deps.configProvider;
        this.problemMatcher = deps.problemMatcher;
        this.bundledMixinPath = deps.bundledMixinPath;
        this.runner = deps.runner ?? new CeedlingRunner();
        this.fs = deps.fileSystem ?? nodeFileSystem;
        this.platform = deps.platform ?? process.platform;
        this.paths = this.platform === 'win32' ? path.win32 : path.posix;
        this.tmpdir = deps.tmpdir ?? os.tmpdir();
    }

    dispose(): void {
        this.cancel();
        this.problemMatcher.dispose();
    }

    getConfiguration(): vscode.WorkspaceConfiguration {
        return this.configProvider(this.workspaceFolder.uri);
    }

    getDebugLaunchConfig(projectKey: string): string {
        return this.project(projectKey).debugLaunchConfig;
    }

    // A gdb log reference in a crash message is relative to the project directory.
    getProjectAbsPath(projectKey: string): string {
        return this.project(projectKey).absPath;
    }

    // Every file a project's configuration can come from, whether or not it exists yet: both
    // default project files, any alternate project file, and each mixin given as a file path.
    // Watching these starts discovery when one appears, changes, or goes away. A mixin given by
    // name resolves through Ceedling's load paths, which aren't known here, so it isn't included.
    configurationFiles(): string[] {
        let projects: CeedlingProject[];
        try {
            projects = this.projectSettings();
        } catch {
            return [];
        }
        const isFilePath = (mixin: string) => /[\\/]/.test(mixin) || /\.ya?ml$/i.test(mixin);
        return [...new Set(projects.flatMap((project) =>
            [DEFAULT_PROJECT_FILE, ALTERNATE_DEFAULT_PROJECT_FILE, project.ymlFileName, ...project.mixins.filter(isFilePath)]
                .map((file) => this.paths.resolve(project.absPath, file))))];
    }

    // The discovered test file at an absolute path, if any.
    testFileAt(absPath: string): { projectKey: string, fileId: string } | undefined {
        const target = this.paths.resolve(absPath);
        for (const project of this.projects.values()) {
            const file = project.files.find((f) => this.paths.resolve(f.absPath) === target);
            if (file) {
                return { projectKey: project.key, fileId: file.id };
            }
        }
        return undefined;
    }

    // Whether a new C file inside a project could be a test file Ceedling would list, judged by
    // the project's test file prefix. Only `ceedling files:test` decides for certain.
    mayBeTestFile(absPath: string): boolean {
        const fileName = this.paths.basename(absPath);
        return fileName.endsWith('.c') && [...this.projects.values()].some((project) => {
            const relative = this.paths.relative(project.absPath, absPath);
            return !relative.startsWith('..') && !this.paths.isAbsolute(relative) && fileName.startsWith(project.state.testFilePrefix);
        });
    }

    // Reparses one discovered test file without running Ceedling, from `source` (e.g. an unsaved
    // editor buffer) or else the file on disk. undefined for a file not discovered.
    async rediscoverFile(projectKey: string, fileId: string, source?: string): Promise<CeedlingFileNode | undefined> {
        const project = this.projects.get(projectKey);
        const index = project?.files.findIndex((f) => f.id === fileId) ?? -1;
        if (!project || index < 0) {
            return undefined;
        }
        const [node] = await this.testFileNodes(project, [fileId], this.prettyLabels(), source);
        if (node) {
            project.files[index] = node;
        }
        return node;
    }

    // Discovers every configured project and its tests. Throws CeedlingLoadError when Ceedling or
    // a project's configuration is unusable. A folder without a project file is zero projects.
    async discover(): Promise<CeedlingProjectNode[]> {
        const settings = this.projectSettings();
        this.candidates = settings.filter((project) => {
            const projectFile = this.paths.resolve(project.absPath, project.ymlFileName);
            const exists = this.fs.exists(projectFile);
            this.logger.debug(
                `discover: project '${project.key}' -> ${projectFile}${exists ? '' : ' (absent, skipped)'}, mixins=${util.format(project.mixins)}`
            );
            return exists;
        });
        if (this.candidates.length === 0) {
            this.projects = new Map();
            return [];
        }

        const loaded = new Map<string, LoadedProject>();
        const errors: string[] = [];
        for (const project of this.candidates) {
            const capabilities = capabilitiesOf(await this.checkCeedlingVersion(project));
            if (project.ambiguousProjectFile && capabilities.ceedlingYml) {
                errors.push(
                    `Both project.yml and ceedling.yml exist in ${project.absPath}, so Ceedling can't tell which is project '${project.key}'. ` +
                    `Remove or rename one, or name the one to use in ceedlingExplorer.projects[].path.`
                );
                continue;
            }
            const resolved = await this.resolveConfig(project, capabilities);
            if (resolved === undefined) {
                errors.push(
                    `Failed to resolve Ceedling's configuration for project '${project.key}' with 'ceedling dumpconfig'. ` +
                    `Check that Ceedling runs in the configured shell (ceedlingExplorer.shellPath), and that ` +
                    `ceedlingExplorer.projects, ceedlingExplorer.mixins, and any projects[].mixins name valid files and mixins.`
                );
                continue;
            }
            const state = projectState(resolved, this.platform);
            this.logger.debug(`discover: project '${project.key}' state=${util.format(state)}`);
            if (!state.reportPluginEnabled) {
                // The bundled mixin always enables the plugin, so the mixin itself didn't apply.
                errors.push(
                    `The required Ceedling plugin 'report_tests_log_factory' did not take effect for project '${project.key}', ` +
                    `even though this extension's own mixin always enables it. Check that ceedlingExplorer.mixins and ` +
                    `projects[].mixins don't reference an invalid mixin.`
                );
                continue;
            }
            this.warnIfNonDefaultReportFilename(project.key, state.reportFilename);
            loaded.set(project.key, { ...project, capabilities, state, files: [] });
        }
        if (errors.length > 0) {
            throw new CeedlingLoadError(errors.join('\n'));
        }

        const labels = this.prettyLabels();
        for (const project of loaded.values()) {
            project.files = await this.testFileNodes(project, await this.listTestFiles(project), labels);
        }
        this.projects = loaded;
        const diagnosticsIds = new Set([...loaded.values()].flatMap((p) => [p.key, ...p.files.map((f) => fileDiagnosticsId(p.key, f.id))]));
        this.problemMatcher.retainIds((id) => diagnosticsIds.has(id));
        return [...loaded.values()].map((project) => ({ projectKey: project.key, label: project.key, files: project.files }));
    }

    async runFile(projectKey: string, file: CeedlingFileNode, reporter: RunReporter, token: Cancellation): Promise<void> {
        const project = this.project(projectKey);
        await this.runTests(project, { kind: 'file', file }, this.testCommandArgs(project, file.id), allIds(file), leafIds(file.functions), reporter, token);
    }

    async runProjectAll(projectKey: string, files: CeedlingFileNode[], reporter: RunReporter, token: Cancellation): Promise<void> {
        const project = this.project(projectKey);
        await this.runTests(
            project, { kind: 'project' }, this.testCommandArgs(project, 'all'),
            files.flatMap(allIds), files.flatMap((file) => leafIds(file.functions)), reporter, token,
        );
    }

    // Runs one function, and all its cases if parametrized, via Ceedling's --test-case filter.
    // The filter narrows what runs and gets reported. Ceedling still compiles the whole file.
    async runFunction(projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction, reporter: RunReporter, token: Cancellation): Promise<void> {
        const name = extractTestFunctionName(fn.id);
        const project = this.project(projectKey);
        const outcome = await this.runTests(
            project, { kind: 'file', file }, this.testCommandArgs(project, file.id, name),
            [fn.id, ...fn.cases.map((c) => c.id)], leafIds([fn]), reporter, token, name,
        );
        if (outcome === 'collision') {
            this.logger.warn(
                `runFunction: --test-case=${name} also matched an unrelated test in '${file.id}'. ` +
                `Ceedling's filter is a substring match, not exact. Falling back to a full-file run.`
            );
            await this.runFile(projectKey, file, reporter, token);
        }
    }

    // Builds and runs the file's tests, reporting their results, then returns the executable's
    // path relative to Ceedling's test output directory, e.g. `test_foo/test_foo.out`. The caller
    // splices it into the user's launch configuration. undefined when the build failed or was
    // cancelled, already reported through `reporter`.
    async compileForDebug(projectKey: string, file: CeedlingFileNode, reporter: RunReporter, token: Cancellation): Promise<string | undefined> {
        const project = this.project(projectKey);
        const ids = allIds(file);
        const leaves = leafIds(file.functions);
        for (const id of ids) {
            reporter.started(id);
        }
        return this.exclusive(async () => {
            const outcome = await this.buildAndRun(project, { kind: 'file', file }, this.testCommandArgs(project, file.id), reporter, token);
            if (outcome.cancelled) {
                leaves.forEach((id) => reporter.skipped(id));
                return undefined;
            }
            if (!outcome.report) {
                this.reportMissingReport(ids, outcome.transcript, outcome.diagnostics, reporter);
                return undefined;
            }
            this.reportResults(outcome.report, leaves, outcome.transcript, reporter);
            return this.executableSubpath(project, file);
        });
    }

    // True when the command succeeded in every project.
    clean(token?: Cancellation): Promise<boolean> {
        return this.runInEveryProject(['clean'], token);
    }

    clobber(token?: Cancellation): Promise<boolean> {
        return this.runInEveryProject(['clobber'], token);
    }

    cancel(): void {
        this.runner.cancelAll();
    }

    private projectSettings(): CeedlingProject[] {
        const config = this.getConfiguration();
        return projectsFromSettings(
            { projects: config.get<ProjectSetting[]>('projects', []), mixins: config.get<string[]>('mixins', []) },
            this.workspaceFolder.uri.fsPath, this.platform, (p) => this.fs.isDirectory(p), (p) => this.fs.exists(p),
        );
    }

    private prettyLabels(): { tests: boolean, files: boolean } {
        const config = this.getConfiguration();
        return { tests: config.get<boolean>('prettyTestLabel', true), files: config.get<boolean>('prettyTestFileLabel', true) };
    }

    private project(projectKey: string): LoadedProject {
        const project = this.projects.get(projectKey);
        if (!project) {
            throw new Error(`Unknown Ceedling project '${projectKey}'.`);
        }
        return project;
    }

    private async exclusive<T>(work: () => Promise<T>): Promise<T> {
        const release = await this.mutex.acquire();
        try {
            return await work();
        } finally {
            release();
        }
    }

    // Runs in the project's own directory, so `:project: :which_ceedling:` selects the Ceedling
    // checked. A build suffix such as `1.2.0-13a540f` counts as its release. Returns the version.
    private async checkCeedlingVersion(project: CeedlingProject): Promise<string> {
        const result = await this.ceedling(['version'], { cwd: project.absPath });
        const reported = parseCeedlingVersionString(result.stdout);
        const version = reported === undefined ? null : semver.coerce(reported);
        this.logger.debug(`checkCeedlingVersion(${project.key}): ${reported}`);
        if (version === null) {
            throw new CeedlingLoadError(
                `Could not run 'ceedling version' for project '${project.key}'. Check that Ceedling is installed and runs ` +
                `in the configured shell (ceedlingExplorer.shellPath).\n${result.stdout}\n${result.stderr}`
            );
        }
        if (semver.lt(version, MINIMUM_CEEDLING_VERSION)) {
            throw new CeedlingLoadError(
                `Ceedling version ${reported} is not supported. This extension requires Ceedling version ` +
                `${MINIMUM_CEEDLING_VERSION} or higher. Please upgrade your Ceedling installation.`
            );
        }
        return reported!;
    }

    // The project's fully merged configuration, from Ceedling itself: project file, mixins, and
    // plugin defaults, as a real build sees them. Ceedling 1.2.0 can write it to stdout. Earlier
    // versions write only to a file, so this goes through a uniquely named temporary file.
    private async resolveConfig(project: CeedlingProject, capabilities: CeedlingCapabilities): Promise<unknown | undefined> {
        if (capabilities.dumpconfigStdout) {
            const result = await this.ceedling(['dumpconfig', '--stdout'], { project });
            if (result.error) {
                this.logger.error(`resolveConfig(${project.key}): 'ceedling dumpconfig --stdout' failed: ${util.format(result)}`);
                return undefined;
            }
            // The YAML starts at its `---` document marker. Anything Ceedling logs before it is skipped.
            const start = result.stdout.search(/^---\s*$/m);
            try {
                return yaml.safeLoad(start >= 0 ? result.stdout.slice(start) : result.stdout);
            } catch (e) {
                this.logger.error(`resolveConfig(${project.key}): could not parse dumpconfig output: ${util.format(e)}`);
                return undefined;
            }
        }
        const outputPath = this.paths.join(this.tmpdir, `ceedling-dumpconfig-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
        const result = await this.ceedling(['dumpconfig', outputPath], { project });
        if (result.error) {
            this.logger.error(`resolveConfig(${project.key}): 'ceedling dumpconfig' failed: ${util.format(result)}`);
            return undefined;
        }
        try {
            return yaml.safeLoad(await this.fs.readFile(outputPath));
        } catch (e) {
            this.logger.error(`resolveConfig(${project.key}): could not read dumpconfig output '${outputPath}': ${util.format(e)}`);
            return undefined;
        } finally {
            this.fs.unlink(outputPath).catch(() => { /* a leftover temporary file is harmless */ });
        }
    }

    private warnIfNonDefaultReportFilename(projectKey: string, reportFilename: string): void {
        if (reportFilename === DEFAULT_CPPUNIT_REPORT_FILENAME || this.warnedNonDefaultReportFilename.has(projectKey)) {
            return;
        }
        this.warnedNonDefaultReportFilename.add(projectKey);
        this.logger.showWarning(
            `Ceedling project '${projectKey}': the CppUnit XML report filename resolves to '${reportFilename}', ` +
            `not the default '${DEFAULT_CPPUNIT_REPORT_FILENAME}' - project.yml or a configured mixin sets ` +
            `':report_tests_log_factory' ↳ ':cppunit' ↳ ':filename'. This extension will use the resolved name; ` +
            `if that's unexpected, check ceedlingExplorer.mixins/projects[].mixins and project.yml.`
        );
    }

    private listTestFiles(project: CeedlingProject): Promise<string[]> {
        return this.exclusive(async () => {
            const result = await this.ceedling(['files:test'], { project });
            if (result.error) {
                this.logger.error(`listTestFiles(${project.key}): 'ceedling files:test' failed: ${util.format(result)}`);
                return [];
            }
            return parseFileListBullets(result.stdout);
        });
    }

    // `source`, when given, stands in for the contents of a single file.
    private async testFileNodes(project: LoadedProject, files: string[], pretty: { tests: boolean, files: boolean }, source?: string): Promise<CeedlingFileNode[]> {
        const options = { testPrefix: project.state.testPrefix, useParamTests: project.state.useParamTests };
        const testLabel = pretty.tests ? this.labelRegex(() => buildTestLabelRegex(project.state.testPrefix)) : undefined;
        const fileLabel = pretty.files ? this.labelRegex(() => buildFileLabelRegex(project.state.testFilePrefix)) : undefined;
        const label = (regex: RegExp | undefined, text: string) => (regex && regex.exec(text)?.[1]) || text;
        const nodes: CeedlingFileNode[] = [];
        for (const file of files) {
            const absPath = this.paths.resolve(project.absPath, file);
            let discovered: ReturnType<typeof discoverTests>;
            try {
                discovered = discoverTests(source ?? await this.fs.readFile(absPath), options);
            } catch (e) {
                // An unreadable file, or a :test_runner: :test_prefix: that isn't a valid regex.
                this.logger.warn(`testFileNodes: skipping '${absPath}' (test prefix '${options.testPrefix}'): ${e}`);
                continue;
            }
            for (const warning of discovered.warnings) {
                this.logger.warn(`testFileNodes: '${file}': ${warning}`);
            }
            nodes.push({
                id: file,
                label: label(fileLabel, file),
                absPath,
                projectKey: project.key,
                functions: discovered.tests.map((test) => ({
                    id: `${file}::${test.name}`,
                    label: label(testLabel, test.name),
                    line: test.line,
                    cases: test.cases.map((testCase) => ({ id: `${file}::${test.name}(${testCase.args})`, label: testCase.args, line: testCase.line })),
                })),
            });
        }
        return nodes;
    }

    // A pretty-label pattern built from a configured prefix, or none if the prefix is invalid.
    private labelRegex(build: () => RegExp): RegExp | undefined {
        try {
            return build();
        } catch (e) {
            this.logger.warn(`Pretty labels are unavailable: ${e}`);
            return undefined;
        }
    }

    // Reports a test run's results. Returns 'collision' instead, reporting nothing, when a
    // --test-case run also reported a test from another function, for the caller to rerun.
    private async runTests(
        project: LoadedProject, scope: RunScope, args: string[], ids: string[], leaves: string[],
        reporter: RunReporter, token: Cancellation, testCaseFilter?: string,
    ): Promise<'done' | 'collision'> {
        for (const id of ids) {
            reporter.started(id);
        }
        return this.exclusive(async () => {
            const outcome = await this.buildAndRun(project, scope, args, reporter, token);
            if (outcome.cancelled) {
                leaves.forEach((id) => reporter.skipped(id));
                return 'done';
            }
            if (!outcome.report) {
                this.reportMissingReport(ids, outcome.transcript, outcome.diagnostics, reporter);
                return 'done';
            }
            if (testCaseFilter !== undefined && !testCaseFilterMatchedExactly(testCaseFilter, reportedNames(outcome.report))) {
                return 'collision';
            }
            this.reportResults(outcome.report, leaves, outcome.transcript, reporter);
            return 'done';
        });
    }

    // Runs Ceedling and gathers everything a run reports from. Stale reports are deleted first, so
    // a report left by an earlier run can't pass as this one's.
    private async buildAndRun(project: LoadedProject, scope: RunScope, args: string[], reporter: RunReporter, token: Cancellation): Promise<BuildOutcome> {
        await this.deleteReports(project);
        // Delta builds reuse cached results keyed without the --test-case filter. A filtered run
        // could then report another run's tests, and a full run only a filtered run's. Rerunning
        // the executable avoids both, while compilation stays incremental.
        const runArgs = project.capabilities.forceTestRerun ? [...args, '--force-test-rerun'] : args;
        const result = await this.ceedling(runArgs, { project, verbose: true, cancellation: token });
        if (result.cancelled || token.isCancellationRequested) {
            return { cancelled: true };
        }
        const transcript = [
            result.stdout.length > 0 ? `stdout:\n${result.stdout}` : undefined,
            result.stderr.length > 0 ? `stderr:\n${result.stderr}` : undefined,
        ].filter((section): section is string => section !== undefined).join('\n');
        reporter.appendOutput(transcript.replace(/\n/g, '\r\n'));
        const diagnostics = this.updateDiagnostics(project, scope, result);
        return { cancelled: false, transcript, diagnostics, report: await this.readReport(project) };
    }

    // A project run supersedes every per-file entry in the project. A file run replaces its own
    // entry and drops the project entry's diagnostics in that file, which it just rebuilt.
    private updateDiagnostics(project: LoadedProject, scope: RunScope, result: CeedlingResult): FileDiagnostic[] {
        const config = this.getConfiguration();
        const diagnostics = this.problemMatcher.match(
            result.stdout, result.stderr, project.absPath,
            config.get<string>('problemMatching.mode', 'disabled'),
            config.get<ProblemMatchingPattern[]>('problemMatching.patterns', []),
        );
        if (scope.kind === 'project') {
            this.problemMatcher.retainIds((id) => !id.startsWith(`${project.key}::`));
            this.problemMatcher.set(project.key, diagnostics);
        } else {
            const testFile = this.paths.resolve(scope.file.absPath);
            this.problemMatcher.set(fileDiagnosticsId(project.key, scope.file.id), diagnostics);
            this.problemMatcher.retain(project.key, (d) => this.paths.resolve(d.file) !== testFile);
        }
        return diagnostics;
    }

    // No report means Ceedling stopped before running tests, usually a build failure. The most
    // severe compiler diagnostic leads each message, when problem matching found one.
    private reportMissingReport(ids: string[], transcript: string, diagnostics: FileDiagnostic[], reporter: RunReporter): void {
        const lead = this.mostSevereDiagnostic(diagnostics);
        const message = lead ? `${lead.diagnostic.message}\n\n${transcript}` : transcript;
        const location = lead ? { file: lead.file, line: lead.diagnostic.range.start.line } : undefined;
        for (const id of ids) {
            reporter.errored(id, message, location);
        }
    }

    private reportResults(report: CppUnitReport, leaves: string[], transcript: string, reporter: RunReporter): void {
        const { results, unmapped } = testResults(report, leaves);
        if (unmapped.length > 0) {
            this.logger.warn(`Ceedling reported results matching no discovered test: ${unmapped.join(', ')}`);
        }
        for (const result of results) {
            switch (result.kind) {
                case 'passed': reporter.passed(result.id); break;
                case 'skipped': reporter.skipped(result.id); break;
                case 'failed': reporter.failed(result.id, `${result.message}\n\n${transcript}`, result.line); break;
                case 'unreported': reporter.errored(result.id, `${UNREPORTED_MESSAGE}\n\n${transcript}`); break;
            }
        }
    }

    // Patterns run warning, error, then catch-all, so the first diagnostic found is not reliably
    // the most severe. vscode's DiagnosticSeverity ranks Error lowest.
    private mostSevereDiagnostic(diagnostics: FileDiagnostic[]): FileDiagnostic | undefined {
        return diagnostics.slice().sort((a, b) => a.diagnostic.severity - b.diagnostic.severity)[0];
    }

    // The executable's path under Ceedling's test output directory. Ceedling before 1.2.0 builds
    // `name/name<ext>`. Ceedling 1.2.0 nests that under the test file's directory relative to its
    // test path, e.g. `unit/name/name<ext>` for `test/unit/name.c`. That test path isn't known
    // here, so each trailing part of the file's directory is tried, and the newest build wins.
    private executableSubpath(project: LoadedProject, file: CeedlingFileNode): string {
        const segments = file.id.split(/[\\/]/);
        const name = segments.pop()!.replace(/\.[^.]*$/, '');
        const executable = `${name}/${name}${project.state.executableExtension}`;
        const outputDirectory = this.paths.resolve(project.absPath, project.state.buildRoot, 'test', 'out');
        const [newest] = segments
            .map((_, i) => [...segments.slice(i), executable].join('/'))
            .concat(executable)
            .map((subpath) => ({ subpath, mtime: this.fs.mtimeMs(this.paths.resolve(outputDirectory, subpath)) }))
            .filter((candidate): candidate is { subpath: string, mtime: number } => candidate.mtime !== undefined)
            .sort((a, b) => b.mtime - a.mtime);
        if (!newest) {
            this.logger.warn(`executableSubpath: no built executable for '${file.id}' under ${outputDirectory}, assuming '${executable}'`);
        }
        return newest?.subpath ?? executable;
    }

    // A test run writes its report under artifacts/test, a gcov run under artifacts/gcov.
    private reportPaths(project: LoadedProject): string[] {
        return ['test', 'gcov'].map((dir) => this.paths.resolve(project.absPath, project.state.buildRoot, 'artifacts', dir, project.state.reportFilename));
    }

    private async deleteReports(project: LoadedProject): Promise<void> {
        for (const reportPath of this.reportPaths(project).filter((p) => this.fs.exists(p))) {
            await this.fs.unlink(reportPath).catch((e) => this.logger.warn(`Failed to delete stale report '${reportPath}': ${e}`));
        }
    }

    // The newer report, when a run such as `test:x gcov:x` wrote both.
    private async readReport(project: LoadedProject): Promise<CppUnitReport | undefined> {
        const [newest] = this.reportPaths(project)
            .map((reportPath) => ({ reportPath, mtime: this.fs.mtimeMs(reportPath) }))
            .filter((r): r is { reportPath: string, mtime: number } => r.mtime !== undefined)
            .sort((a, b) => b.mtime - a.mtime);
        if (!newest) {
            this.logger.debug(`readReport(${project.key}): Ceedling produced no CppUnit report`);
            return undefined;
        }
        try {
            return await parseCppUnitReport(await this.fs.readFile(newest.reportPath));
        } catch (e) {
            this.logger.warn(`readReport(${project.key}): could not read '${newest.reportPath}': ${util.format(e)}`);
            return undefined;
        }
    }

    private async runInEveryProject(args: string[], token?: Cancellation): Promise<boolean> {
        return this.exclusive(async () => {
            let succeeded = true;
            for (const project of this.candidates) {
                const result = await this.ceedling(args, { project, cancellation: token });
                succeeded = succeeded && !result.error;
            }
            return succeeded;
        });
    }

    // `${TEST_ID}` in each configured argument becomes the test file: its project-relative path
    // where Ceedling accepts one, which tells same-named files apart, else its name alone.
    // `testCaseFilter` appends Ceedling's --test-case flag, which enables the runner's command-line
    // arguments itself.
    private testCommandArgs(project: LoadedProject, testId: string, testCaseFilter?: string): string[] {
        const testFile = project.capabilities.pathQualifiedTestTasks ? testId : testId.replace(/^.*[\\/]/, '');
        const args = this.getConfiguration()
            .get<string[]>('testCommandArgs', ['test:${TEST_ID}'])
            .map((arg) => arg.replaceAll('${TEST_ID}', testFile));
        return testCaseFilter === undefined ? args : [...args, `--test-case=${testCaseFilter}`];
    }

    // `project` adds its --project/--mixin flags and runs in its directory. `verbose` adds
    // DEBUG_VERBOSITY in development mode only, so it never ships to a Marketplace install.
    private async ceedling(
        args: string[],
        options: { project?: CeedlingProject, cwd?: string, verbose?: boolean, cancellation?: Cancellation },
    ): Promise<CeedlingResult> {
        const config = this.getConfiguration();
        const fullArgs = [...args];
        if (options.project) {
            fullArgs.push(...buildProjectArgs(options.project.projectFileName, options.project.ymlFileName, options.project.mixins, this.bundledMixinPath));
        }
        const verbose = this.isDevelopmentMode && options.verbose === true;
        if (verbose) {
            fullArgs.push(...DEBUG_VERBOSITY);
        }
        const cwd = options.cwd ?? options.project?.absPath ?? this.workspaceFolder.uri.fsPath;
        const command = config.get<string>('ceedlingCommand', 'ceedling').trim() || 'ceedling';
        const shellSetting = config.get<string | null>('shellPath', null);
        const shell = shellSetting && shellSetting !== 'null' ? shellSetting : undefined;
        this.logger.debug(`ceedling: ${buildCommandLine(command, fullArgs)} (cwd=${cwd}, shell=${shell ?? 'default'})`);
        const result = await this.runner.run({
            command,
            args: fullArgs,
            cwd,
            shell,
            stripAnsi: config.get<boolean>('ansiEscapeSequencesRemoved', true),
            cancellation: options.cancellation,
        });
        if (verbose) {
            this.logger.debug(`stdout:\n${result.stdout}` + (result.stderr.length > 0 ? `\nstderr:\n${result.stderr}` : ''));
        }
        return result;
    }
}
