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

import crypto from 'crypto';
import fs from 'fs';
import yaml from 'js-yaml';
import os from 'os';
import path from 'path';
import util from 'util';
import type vscode from 'vscode';
import { buildProjectArgs } from './ceedlingMixinArgs';
import { KeyedLock, Limiter, mapGrouped } from './concurrency';
import {
    buildFileLabelRegex,
    buildTestLabelRegex,
    extractCeedlingException,
    extractTestFunctionName,
    parseCeedlingVersions,
    parseFileListBullets,
    testCaseFilterMatchedExactly,
} from './ceedlingOutputParsing';
import { buildCommandLine, type Cancellation, type CeedlingResult, CeedlingRunner } from './ceedlingProcess';
import {
    ALTERNATE_DEFAULT_PROJECT_FILE,
    applicationRelease,
    capabilitiesOf,
    coverageProblem,
    type CeedlingCapabilities,
    CeedlingLoadError,
    type CeedlingProject,
    DEFAULT_CPPUNIT_REPORT_FILENAME,
    DEFAULT_PROJECT_FILE,
    firstRelease,
    isSupportedRelease,
    MINIMUM_CEEDLING_VERSION,
    pathKey,
    type ProjectSetting,
    type ProjectState,
    projectState,
    projectsFromSettings,
    testBuildLayout,
    testBuildName,
    versionSeesSelection,
} from './ceedlingProjectConfig';
import { parseCoberturaReport, reportedFiles } from './coberturaReport';
import type { Logger } from './logger';
import type { FileDiagnostic, ProblemMatcher } from './problemMatcher';
import { allIds, type CeedlingFileNode, type CeedlingProjectNode, type CeedlingTestFunction, type CoverageOutcome, leafIds, type RunReporter } from './testModel';
import { type CppUnitReport, parseCppUnitReport, reportedNames, testResults } from './testResults';
import { discoverTests } from './unityTestDiscovery';

export { CeedlingLoadError } from './ceedlingProjectConfig';

// Added to test runs and debug builds in development mode only, for the extension's own logs.
const DEBUG_VERBOSITY = ['--verbosity', 'debug'];
// Enough to overlap file reads, few enough to stay clear of file descriptor limits.
const MAX_CONCURRENT_READS = 16;
const UNREPORTED_MESSAGE =
    "Ceedling reported no result for this test. Its name as found in the source may not match the name Ceedling's test runner gave it.";

// The filesystem operations the engine needs, all asynchronous: synchronous I/O would block the
// extension host thread every extension shares. Tests substitute an in-memory implementation.
export interface EngineFileSystem {
    exists(filePath: string): Promise<boolean>;
    isDirectory(filePath: string): Promise<boolean>;
    readFile(filePath: string): Promise<string>;
    unlink(filePath: string): Promise<void>;
    // Every file beneath a directory, at any depth. Empty when the directory doesn't exist.
    listFiles(directory: string): Promise<string[]>;
    // undefined when the file doesn't exist.
    mtimeMs(filePath: string): Promise<number | undefined>;
}

// A missing or unreadable path is undefined rather than an error.
async function statOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
    try {
        return await fs.promises.stat(filePath);
    } catch {
        return undefined;
    }
}

export const nodeFileSystem: EngineFileSystem = {
    exists: async (filePath) => (await statOrUndefined(filePath)) !== undefined,
    isDirectory: async (filePath) => (await statOrUndefined(filePath))?.isDirectory() ?? false,
    readFile: (filePath) => fs.promises.readFile(filePath, 'utf8'),
    unlink: (filePath) => fs.promises.unlink(filePath),
    // One directory at a time, so a deep tree never holds many directory handles open at once.
    listFiles: async (directory) => {
        const found: string[] = [];
        const pending = [directory];
        for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
            // eslint-disable-next-line no-await-in-loop -- one directory at a time, see above
            const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                (entry.isDirectory() ? pending : found).push(path.join(current, entry.name));
            }
        }
        return found.sort();
    },
    mtimeMs: async (filePath) => (await statOrUndefined(filePath))?.mtimeMs,
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

// The Ceedling that runs a project, as `ceedling version` reports it. `release` counts a build as
// its release, e.g. 1.2.0 for 1.2.0-13a540f. `exactRelease` is false when the report can't show
// the release, and the launcher's stands in. See applicationRelease().
type ProjectCeedling = { release: string, exactRelease: boolean, capabilities: CeedlingCapabilities };

// `configuration` fingerprints the files and settings `state` was resolved from.
type LoadedProject = CeedlingProject & ProjectCeedling & { state: ProjectState, configuration: string, files: CeedlingFileNode[] };

// A mixin naming a file, rather than one Ceedling finds by name through its load paths.
function isMixinFile(mixin: string): boolean {
    return /[\\/]/.test(mixin) || /\.ya?ml$/i.test(mixin);
}

function isLoaded(project: CeedlingProject): project is LoadedProject {
    return 'state' in project;
}

type LoadOutcome =
    | { kind: 'loaded', project: LoadedProject }
    | { kind: 'error', message: string }
    | { kind: 'unusable', error: unknown };

// What a run compiled. A file run's diagnostics replace only that file's, a project run's all.
type RunScope = { kind: 'project' } | { kind: 'file', file: CeedlingFileNode };

// One coverage request, which may run Ceedling several times. Its build directories' coverage
// counters are cleared before their first build only, so later builds add to this request's own.
type CoverageRun = { readonly resetDirectories: Set<string> };

export type RunMode = { kind: 'test' } | { kind: 'coverage', run: CoverageRun };

const TEST_MODE: RunMode = { kind: 'test' };

export function coverageMode(): RunMode {
    return { kind: 'coverage', run: { resetDirectories: new Set() } };
}

// `exception` is Ceedling's own account of why it stopped, when it did.
type BuildOutcome =
    | { cancelled: true }
    | { cancelled: false, transcript: string, exception: string | undefined, diagnostics: FileDiagnostic[], report: CppUnitReport | undefined, coverage: CoverageOutcome | undefined };

type CompletedBuild = Extract<BuildOutcome, { cancelled: false }>;

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
    // One build, clean, or clobber at a time per project directory and per build root. Builds
    // sharing a build root share its reports and counters. Discovery's commands queue too, unless
    // discovering() finds them read-only. Before 1.2.1 every command that loads a project rewrites
    // the Unity and CMock copies in its build root in place. That can corrupt a build it overlaps.
    // Work elsewhere proceeds independently. `ceedling version` needs no lock.
    private readonly locks = new KeyedLock();
    // Every source read in the engine shares one limit, so overlapping discoveries and a burst of
    // watcher-driven reparses (e.g. a branch checkout) can't exhaust file descriptors together.
    private readonly reads = new Limiter(MAX_CONCURRENT_READS);

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
    async configurationFiles(): Promise<string[]> {
        let projects: CeedlingProject[];
        try {
            projects = await this.projectSettings();
        } catch {
            return [];
        }
        return [...new Set(projects.flatMap((project) =>
            [DEFAULT_PROJECT_FILE, ALTERNATE_DEFAULT_PROJECT_FILE, project.ymlFileName, ...project.mixins.filter(isMixinFile)]
                .map((file) => this.paths.resolve(project.absPath, file))))];
    }

    // The discovered test file at an absolute path, if any. VS Code's paths may differ in case from
    // discovered ones on Windows, e.g. in the drive letter.
    testFileAt(absPath: string): { projectKey: string, fileId: string } | undefined {
        const target = pathKey(this.paths.resolve(absPath), this.platform);
        for (const project of this.projects.values()) {
            const file = project.files.find((f) => pathKey(this.paths.resolve(f.absPath), this.platform) === target);
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
        const settings = await this.projectSettings();
        const projectFiles = settings.map((project) => this.paths.resolve(project.absPath, project.ymlFileName));
        const present = await Promise.all(projectFiles.map((projectFile) => this.fs.exists(projectFile)));
        this.candidates = settings.filter((project, i) => {
            this.logger.debug(
                `discover: project '${project.key}' -> ${projectFiles[i]}${present[i] ? '' : ' (absent, skipped)'}, mixins=${util.format(project.mixins)}`
            );
            return present[i];
        });
        if (this.candidates.length === 0) {
            this.projects = new Map();
            return [];
        }

        // Projects load concurrently across directories and one at a time within a directory. Each also
        // waits out other work in its directory and last-known build root, unless discovering() finds
        // its dumpconfig read-only.
        // Outcomes apply in settings order, so errors read the same however the loads interleave.
        const outcomes = await mapGrouped(this.candidates, (project) => this.directoryOf(project), (project) => this.loadProject(project));
        const loaded = new Map<string, LoadedProject>();
        const errors: string[] = [];
        for (const outcome of outcomes) {
            if (outcome.kind === 'unusable') {
                throw outcome.error;
            }
            if (outcome.kind === 'error') {
                errors.push(outcome.message);
                continue;
            }
            this.warnIfNonDefaultReportFilename(outcome.project.key, outcome.project.state.reportFilename);
            loaded.set(outcome.project.key, outcome.project);
        }
        if (errors.length > 0) {
            throw new CeedlingLoadError(errors.join('\n'));
        }

        // Listing runs Ceedling in each project directory, under its locks unless discovering() finds it
        // read-only. A failed listing fails discovery, rather than showing a project with no tests.
        // Reading and parsing sources needs no lock.
        const projects = [...loaded.values()];
        const listings = await mapGrouped(projects, (project) => this.directoryOf(project),
            (project) => this.discovering(project, project, project.state, () => this.listTestFiles(project)));
        const unlisted = projects.filter((_, i) => listings[i] === undefined);
        if (unlisted.length > 0) {
            throw new CeedlingLoadError(unlisted.map((project) =>
                `Failed to list the test files of Ceedling project '${project.key}' with 'ceedling files:test'. ` +
                `Check that Ceedling runs in the configured shell (ceedlingExplorer.shellPath), and that the project's ` +
                `:paths: ↳ :test: entries are valid. The Ceedling Explorer log has Ceedling's output.`).join('\n'));
        }
        const labels = this.prettyLabels();
        await Promise.all(projects.map(async (project, i) => {
            project.files = await this.testFileNodes(project, listings[i] ?? [], labels);
        }));
        this.projects = loaded;
        const diagnosticsIds = new Set([...loaded.values()].flatMap((p) => [p.key, ...p.files.map((f) => fileDiagnosticsId(p.key, f.id))]));
        this.problemMatcher.retainIds((id) => diagnosticsIds.has(id));
        return [...loaded.values()].map((project) => ({ projectKey: project.key, label: project.key, files: project.files }));
    }

    async runFile(projectKey: string, file: CeedlingFileNode, reporter: RunReporter, token: Cancellation, mode = TEST_MODE): Promise<void> {
        await this.runWholeFile(this.project(projectKey), file, reporter, token, mode);
    }

    async runProjectAll(projectKey: string, files: CeedlingFileNode[], reporter: RunReporter, token: Cancellation, mode = TEST_MODE): Promise<void> {
        const project = this.project(projectKey);
        await this.runTests(
            project, { kind: 'project' }, mode, this.commandArgs(project, 'all', mode),
            files.flatMap(allIds), files.flatMap((file) => leafIds(file.functions)), reporter, token,
        );
    }

    // Runs one function, and all its cases if parametrized, via Ceedling's --test-case filter.
    // The filter narrows what runs and gets reported. Ceedling still compiles the whole file.
    async runFunction(projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction, reporter: RunReporter, token: Cancellation, mode = TEST_MODE): Promise<void> {
        const name = extractTestFunctionName(fn.id);
        const project = this.project(projectKey);
        const outcome = await this.runTests(
            project, { kind: 'file', file }, mode, this.commandArgs(project, file.id, mode, name),
            [fn.id, ...fn.cases.map((c) => c.id)], leafIds([fn]), reporter, token, name,
        );
        if (outcome === 'collision') {
            this.logger.warn(
                `runFunction: --test-case=${name} also matched an unrelated test in '${file.id}'. ` +
                `Ceedling's filter is a substring match, not exact. Falling back to a full-file run.`
            );
            if (mode.kind === 'coverage') {
                await this.exclusively(project, () => this.clearTestCounters(project, file));
            }
            await this.runWholeFile(project, file, reporter, token, mode);
        }
    }

    // Runs a whole file on the project the caller started with. A rediscovery since may have
    // replaced or dropped it.
    private async runWholeFile(project: LoadedProject, file: CeedlingFileNode, reporter: RunReporter, token: Cancellation, mode: RunMode): Promise<void> {
        await this.runTests(project, { kind: 'file', file }, mode, this.commandArgs(project, file.id, mode), allIds(file), leafIds(file.functions), reporter, token);
    }

    // The key two spellings of one path share, as this engine's platform compares paths.
    keyOfPath(filePath: string): string {
        return pathKey(filePath, this.platform);
    }

    // Whether any project enables Ceedling's gcov plugin, and so can run with coverage.
    coverageEnabled(): boolean {
        return [...this.projects.values()].some((project) => project.state.coverage !== undefined);
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
        return this.exclusively(project, async () => {
            const candidates = this.executableCandidates(project, file);
            const before = await this.executableTimes(project, candidates);
            const outcome = await this.buildAndRun(project, { kind: 'file', file }, TEST_MODE, this.commandArgs(project, file.id, TEST_MODE), reporter, token);
            if (outcome.cancelled) {
                leaves.forEach((id) => reporter.skipped(id));
                return undefined;
            }
            if (!outcome.report) {
                this.reportMissingReport(ids, outcome, reporter);
                return undefined;
            }
            this.reportResults(outcome.report, leaves, outcome.transcript, reporter);
            return await this.executableSubpath(project, file, candidates, before);
        });
    }

    // False when the command failed in some project. A cancelled command is no failure.
    clean(token?: Cancellation): Promise<boolean> {
        return this.runInEveryProject(['clean'], token);
    }

    clobber(token?: Cancellation): Promise<boolean> {
        return this.runInEveryProject(['clobber'], token);
    }

    cancel(): void {
        this.runner.cancelAll();
    }

    private projectSettings(): Promise<CeedlingProject[]> {
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

    // The key a project's directory groups its work under.
    private directoryOf(project: CeedlingProject): string {
        return pathKey(project.absPath, this.platform);
    }

    // Runs work holding the project's locks: its directory's, and its build root's once a
    // discovery has resolved it. A rediscovery takes the build root the last discovery found,
    // which any build still running uses. A project no discovery has loaded yet holds only its
    // directory's, so before 1.2.1 its first dumpconfig can still rewrite a shared build root's
    // vendored sources under another project's build.
    private exclusively<T>(project: CeedlingProject, work: () => Promise<T>): Promise<T> {
        const loaded = isLoaded(project) ? project : this.projects.get(project.key);
        const buildRoot = loaded ? [`build:${pathKey(this.buildPath(loaded), this.platform)}`] : [];
        return this.locks.runAll([`directory:${this.directoryOf(project)}`, ...buildRoot], work);
    }

    // Runs dumpconfig or files:test for discovery, without the project's locks where they write
    // nothing. Before Ceedling 1.2.1 both rewrite the build root's vendored sources, so they hold the
    // locks as builds do. From 1.2.1 they run alongside builds, cleans, and clobbers.
    // - `ceedling` comes from this discovery's version check. It counts only when that check showed
    //   its release exactly.
    // - Before 1.2.2 the check never reads the project file. It stands only when `state`, the project's
    //   configuration as last known, selects the Ceedling the check sees. With no known state, the
    //   locks hold.
    private discovering<T>(project: CeedlingProject, ceedling: ProjectCeedling, state: ProjectState | undefined, work: () => Promise<T>): Promise<T> {
        const writesNothing = ceedling.capabilities.readOnlyDiscovery && ceedling.exactRelease &&
            state !== undefined && versionSeesSelection(state.whichCeedling, project.absPath, this.platform);
        return writesNothing ? work() : this.exclusively(project, work);
    }

    // Checks one project's Ceedling and resolves its configuration. An unusable Ceedling stops all
    // discovery. A configuration problem is reported alongside any others.
    private async loadProject(project: CeedlingProject): Promise<LoadOutcome> {
        let ceedling: ProjectCeedling;
        try {
            const { release, exactRelease } = await this.checkCeedlingVersion(project);
            ceedling = { release, exactRelease, capabilities: capabilitiesOf(release) };
        } catch (error) {
            return { kind: 'unusable', error };
        }
        const { capabilities } = ceedling;
        if (project.ambiguousProjectFile && capabilities.ceedlingYml) {
            return {
                kind: 'error',
                message: `Both project.yml and ceedling.yml exist in ${project.absPath}, so Ceedling can't tell which is project '${project.key}'. ` +
                    `Remove or rename one, or name the one to use in ceedlingExplorer.projects[].path.`,
            };
        }
        // The last discovery's state is known only while the configuration it came from is unchanged.
        // An edit that just selected another Ceedling is invisible to the version check.
        const configuration = await this.configurationFingerprint(project);
        const previous = this.projects.get(project.key);
        const known = previous?.configuration === configuration ? previous.state : undefined;
        const resolved = await this.discovering(project, ceedling, known, () => this.resolveConfig(project, capabilities));
        if (resolved === undefined) {
            return {
                kind: 'error',
                message: `Failed to resolve Ceedling's configuration for project '${project.key}' with 'ceedling dumpconfig'. ` +
                    `Check that Ceedling runs in the configured shell (ceedlingExplorer.shellPath), and that ` +
                    `ceedlingExplorer.projects, ceedlingExplorer.mixins, and any projects[].mixins name valid files and mixins.`,
            };
        }
        const state = projectState(resolved, this.platform);
        this.logger.debug(`loadProject: project '${project.key}' state=${util.format(state)}`);
        if (!state.reportPluginEnabled) {
            // The bundled mixin always enables the plugin, so the mixin itself didn't apply.
            return {
                kind: 'error',
                message: `The required Ceedling plugin 'report_tests_log_factory' did not take effect for project '${project.key}', ` +
                    `even though this extension's own mixin always enables it. Check that ceedlingExplorer.mixins and ` +
                    `projects[].mixins don't reference an invalid mixin.`,
            };
        }
        return { kind: 'loaded', project: { ...project, ...ceedling, state, configuration, files: [] } };
    }

    // A digest of what the project's configuration comes from: its directory, its project files,
    // its mixins setting, and the contents of each file among them. A mixin given by name resolves
    // through Ceedling's load paths, so only its name counts.
    private async configurationFingerprint(project: CeedlingProject): Promise<string> {
        const files = [...new Set([project.projectFileName, project.ymlFileName, ...project.mixins.filter(isMixinFile)])];
        const contents = await Promise.all(files.map((file) =>
            this.reads.run(() => this.fs.readFile(this.paths.resolve(project.absPath, file))).catch(() => null)));
        const parts = [project.absPath, project.projectFileName, project.ymlFileName, project.mixins, files, contents];
        return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    }

    // Returns the release of the Ceedling the project directory runs, and whether the report shows it
    // exactly. Running there finds a Ceedling vendored in `vendor/ceedling`. WHICH_CEEDLING applies
    // anywhere. Before 1.2.2 `ceedling version` never loads the project file, so a `:project` ↳
    // `:which_ceedling` there goes unseen. See discovering().
    private async checkCeedlingVersion(project: CeedlingProject): Promise<{ release: string, exactRelease: boolean }> {
        const result = await this.ceedling(['version'], { cwd: project.absPath });
        const reported = parseCeedlingVersions(result.stdout);
        const release = reported === undefined ? undefined : applicationRelease(reported);
        this.logger.debug(`checkCeedlingVersion(${project.key}): ${reported === undefined ? 'none' : util.format(reported)}`);
        if (reported === undefined || release === undefined) {
            throw new CeedlingLoadError(
                `Could not run 'ceedling version' for project '${project.key}'. Check that Ceedling is installed and runs ` +
                `in the configured shell (ceedlingExplorer.shellPath).\n${result.stdout}\n${result.stderr}`
            );
        }
        if (!isSupportedRelease(release.release)) {
            throw new CeedlingLoadError(
                `Ceedling version ${reported.application} is not supported. This extension requires Ceedling version ` +
                `${MINIMUM_CEEDLING_VERSION} or higher. Please upgrade your Ceedling installation.`
            );
        }
        if (!release.exactRelease) {
            this.logger.warn(`Project '${project.key}' runs Ceedling ${reported.application} from another installation. ` +
                `Its launcher, Ceedling ${reported.launcher}, can't tell its release, so this extension treats it as ` +
                `${release.release} and discovery waits for runs. Launchers from Ceedling ${firstRelease('reportsApplicationVersion')} ` +
                `report it (Ceedling#1365).`);
        }
        return release;
    }

    // The project's fully merged configuration, from Ceedling itself: project file, mixins, and
    // plugin defaults, as a real build sees them. Ceedling 1.2.0 can write it to stdout. Earlier
    // versions write only to a file, so this goes through a uniquely named temporary file.
    private async resolveConfig(project: CeedlingProject, capabilities: CeedlingCapabilities): Promise<unknown> {
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
            return yaml.safeLoad(await this.reads.run(() => this.fs.readFile(outputPath)));
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

    // Callers gate its locks through discovering(). undefined when Ceedling failed, with its output logged.
    private async listTestFiles(project: CeedlingProject): Promise<string[] | undefined> {
        const result = await this.ceedling(['files:test'], { project });
        if (result.error) {
            this.logger.error(`listTestFiles(${project.key}): 'ceedling files:test' failed: ${util.format(result)}`);
            return undefined;
        }
        return parseFileListBullets(result.stdout);
    }

    // `source`, when given, stands in for the contents of a single file.
    private async testFileNodes(project: LoadedProject, files: string[], pretty: { tests: boolean, files: boolean }, source?: string): Promise<CeedlingFileNode[]> {
        const options = { testPrefix: project.state.testPrefix, useParamTests: project.state.useParamTests };
        const testLabel = pretty.tests ? this.labelRegex(() => buildTestLabelRegex(project.state.testPrefix)) : undefined;
        const fileLabel = pretty.files ? this.labelRegex(() => buildFileLabelRegex(project.state.testFilePrefix)) : undefined;
        // `||`, not `??`: an empty capture, such as a file named only by its prefix, keeps the full text.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- see above
        const label = (regex: RegExp | undefined, text: string) => regex?.exec(text)?.[1] || text;
        // Sources are read concurrently, within the engine's shared read limit, then parsed in
        // listed order.
        const sources = await Promise.all(files.map(async (file) => {
            const absPath = this.paths.resolve(project.absPath, file);
            try {
                return { file, absPath, text: source ?? await this.reads.run(() => this.fs.readFile(absPath)) };
            } catch (error) {
                return { file, absPath, error };
            }
        }));
        const nodes: CeedlingFileNode[] = [];
        for (const { file, absPath, text, error } of sources) {
            let discovered: ReturnType<typeof discoverTests>;
            try {
                if (text === undefined) {
                    throw error;
                }
                discovered = discoverTests(text, options);
            } catch (e) {
                // An unreadable file, or a :test_runner: :test_prefix: that isn't a valid regex.
                this.logger.warn(`testFileNodes: skipping '${absPath}' (test prefix '${options.testPrefix}'): ${util.format(e)}`);
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
            this.logger.warn(`Pretty labels are unavailable: ${util.format(e)}`);
            return undefined;
        }
    }

    // Reports a test run's results. Returns 'collision' instead, reporting nothing, when a
    // --test-case run also reported a test from another function, for the caller to rerun.
    private async runTests(
        project: LoadedProject, scope: RunScope, mode: RunMode, args: string[], ids: string[], leaves: string[],
        reporter: RunReporter, token: Cancellation, testCaseFilter?: string,
    ): Promise<'done' | 'collision'> {
        for (const id of ids) {
            reporter.started(id);
        }
        return this.exclusively(project, async () => {
            const outcome = await this.buildAndRun(project, scope, mode, args, reporter, token);
            if (outcome.cancelled) {
                leaves.forEach((id) => reporter.skipped(id));
                return 'done';
            }
            if (!outcome.report) {
                this.reportMissingReport(ids, outcome, reporter);
                // The test errors explain a failed build, but not a configuration that can't give coverage.
                const problem = mode.kind === 'coverage' ? this.coverageConfigurationProblem(project) : undefined;
                if (problem !== undefined) {
                    reporter.coverage({ kind: 'missing', message: problem });
                }
                return 'done';
            }
            if (testCaseFilter !== undefined && !testCaseFilterMatchedExactly(testCaseFilter, reportedNames(outcome.report))) {
                return 'collision';
            }
            this.reportResults(outcome.report, leaves, outcome.transcript, reporter);
            if (outcome.coverage) {
                reporter.coverage(outcome.coverage);
            }
            return 'done';
        });
    }

    // Runs Ceedling and gathers everything a run reports from. Stale reports are deleted first, so
    // a report left by an earlier run can't pass as this one's.
    // Callers hold the project's locks, so a coverage report read here is this build's.
    private async buildAndRun(project: LoadedProject, scope: RunScope, mode: RunMode, args: string[], reporter: RunReporter, token: Cancellation): Promise<BuildOutcome> {
        await this.deleteStale(this.reportPaths(project));
        if (mode.kind === 'coverage') {
            await this.prepareCoverage(project, mode.run);
        }
        // Delta builds reuse cached results unless told to rerun, while compilation stays
        // incremental either way. Before 1.2.1 their cache ignores the --test-case filter, so a
        // filtered run could report another run's tests. In every version the cache also ignores
        // deleted coverage counters, so a coverage run after a reset would report no coverage.
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
        const exception = extractCeedlingException(result.stderr) ?? extractCeedlingException(result.stdout);
        const diagnostics = this.updateDiagnostics(project, scope, result);
        const coverage = mode.kind === 'coverage' ? await this.readCoverage(project) : undefined;
        return { cancelled: false, transcript, exception, diagnostics, report: await this.readReport(project), coverage };
    }

    // A project run supersedes every per-file entry in the project. A file run replaces its own
    // entry and drops the project entry's diagnostics in that file, which it just rebuilt. A build
    // that outlived a rediscovery dropping its project or file publishes nothing. A rediscovery never
    // takes a dropped project's locks, and from Ceedling 1.2.1 often none of its own.
    private updateDiagnostics(project: LoadedProject, scope: RunScope, result: CeedlingResult): FileDiagnostic[] {
        const config = this.getConfiguration();
        const diagnostics = this.problemMatcher.match(
            result.stdout, result.stderr, project.absPath,
            config.get<string>('problemMatching.mode', 'disabled'),
            // Untyped user JSON. ProblemMatcher validates each pattern.
            config.get<unknown[]>('problemMatching.patterns', []),
        );
        const current = this.projects.get(project.key);
        if (current === undefined || (scope.kind === 'file' && !current.files.some((f) => f.id === scope.file.id))) {
            return diagnostics;
        }
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

    // No report means Ceedling stopped before running tests, usually a build failure. The Testing
    // view shows a message's first line, so the most severe compiler diagnostic leads, when problem
    // matching found one, then Ceedling's exception, then the whole transcript.
    private reportMissingReport(ids: string[], build: CompletedBuild, reporter: RunReporter): void {
        const lead = this.mostSevereDiagnostic(build.diagnostics);
        const message = [lead?.diagnostic.message, build.exception, build.transcript].filter((part) => part !== undefined).join('\n\n');
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

    // Where each release's layout puts the file's executable under Ceedling's test output
    // directory, `<build name>/<name><ext>`, the project's release's own first. See testBuildName().
    private executableCandidates(project: LoadedProject, file: CeedlingFileNode): string[] {
        const own = testBuildLayout(project.capabilities);
        const layouts = [own, ...(['projectPath', 'testRoot', 'flat'] as const).filter((layout) => layout !== own)];
        const placed = { testPaths: project.state.testPaths, projectDir: project.absPath, platform: this.platform };
        return [...new Set(layouts.map((layout) => {
            const buildName = testBuildName(file.id, layout, placed);
            return `${buildName}/${buildName.replace(/^.*\//, '')}${project.state.executableExtension}`;
        }))];
    }

    private executableTimes(project: LoadedProject, candidates: readonly string[]): Promise<Array<number | undefined>> {
        const outputDirectory = this.buildPath(project, 'test', 'out');
        return Promise.all(candidates.map((candidate) => this.fs.mtimeMs(this.paths.resolve(outputDirectory, candidate))));
    }

    // The executable's path under Ceedling's test output directory: the candidate this build
    // wrote, else one that exists, else the release's own. Each release's layout comes first. A
    // launcher before 1.2.2 can misreport a newer application's release (Ceedling#1365), so the
    // build itself decides where it went. A delta build may write nothing, leaving one up to date.
    private async executableSubpath(project: LoadedProject, file: CeedlingFileNode, candidates: readonly string[], before: ReadonlyArray<number | undefined>): Promise<string> {
        const after = await this.executableTimes(project, candidates);
        const written = after.findIndex((time, i) => time !== undefined && time !== before[i]);
        const existing = after.findIndex((time) => time !== undefined);
        const chosen = written >= 0 ? written : Math.max(existing, 0);
        if (existing < 0) {
            this.logger.warn(`executableSubpath: no built executable for '${file.id}' at '${candidates[0]}' under ${this.buildPath(project, 'test', 'out')}`);
        } else if (chosen > 0) {
            this.logger.warn(`executableSubpath: '${file.id}' built at '${candidates[chosen]}', not at '${candidates[0]}', where Ceedling ${project.release} would build it`);
        }
        return candidates[chosen];
    }

    // Where Ceedling builds the test file, beneath each build output directory, as the project's
    // release lays it out.
    private testBuildName(project: LoadedProject, file: CeedlingFileNode): string {
        return testBuildName(file.id, testBuildLayout(project.capabilities), { testPaths: project.state.testPaths, projectDir: project.absPath, platform: this.platform });
    }

    // A test run writes its report under artifacts/test, a gcov run under artifacts/gcov.
    private reportPaths(project: LoadedProject): string[] {
        return ['test', 'gcov'].map((dir) => this.buildPath(project, 'artifacts', dir, project.state.reportFilename));
    }

    // Deletes whichever files exist. A file that won't go is logged, and the build goes ahead.
    private async deleteStale(filePaths: string[]): Promise<void> {
        await Promise.all(filePaths.map((filePath) => this.fs.unlink(filePath).catch((e: unknown) => {
            if ((e as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
                this.logger.warn(`Failed to delete stale file '${filePath}': ${util.format(e)}`);
            }
        })));
    }

    // Where the project's Cobertura report may appear, most preferred first.
    private coberturaPaths(project: LoadedProject): string[] {
        return (project.state.coverage?.coberturaReports ?? []).map((report) => this.buildPath(project, report));
    }

    // Clears what earlier runs left: stale Cobertura reports before every coverage build, and the
    // build directory's coverage counters before the request's first build there. A failed build
    // would otherwise leave the last run's report to be read as this one's, and the tools report
    // every counter on disk. The counters stay when the user chose to accumulate them.
    private async prepareCoverage(project: LoadedProject, run: CoverageRun): Promise<void> {
        await this.deleteStale(this.coberturaPaths(project));
        const key = pathKey(this.countersDirectory(project), this.platform);
        if (project.state.coverage === undefined || run.resetDirectories.has(key) || !this.resetsCounters()) {
            return;
        }
        run.resetDirectories.add(key);
        await this.deleteStale((await this.counters(project)).map((counter) => counter.file));
    }

    // Clears one test file's counters before a whole-file run repeats the tests its filtered run
    // just counted. They sit beneath the file's build directory in gcov/out, e.g.
    // gcov/out/unit/test_foo/ for test/unit/test_foo.c, so same-named test files elsewhere keep
    // theirs. Windows folds case, and keeps whatever case Ceedling created a directory with.
    private async clearTestCounters(project: LoadedProject, file: CeedlingFileNode): Promise<void> {
        if (!this.resetsCounters()) {
            return;
        }
        const key = (segment: string) => pathKey(segment, this.platform);
        const own = this.testBuildName(project, file).split('/').map(key);
        const counters = await this.counters(project);
        await this.deleteStale(counters
            .filter((counter) => own.every((segment, i) => counter.segments[i] !== undefined && key(counter.segments[i]) === segment))
            .map((counter) => counter.file));
    }

    private resetsCounters(): boolean {
        return this.getConfiguration().get<boolean>('coverageResetsCounters', true);
    }

    private countersDirectory(project: LoadedProject): string {
        return this.buildPath(project, 'gcov', 'out');
    }

    // A path within the project's build root, `:project` ↳ `:build_root`, relative to its directory.
    private buildPath(project: LoadedProject, ...segments: string[]): string {
        return this.paths.resolve(project.absPath, project.state.buildRoot, ...segments);
    }

    // gcov's counters (.gcda) and ReportGenerator's .gcov inputs, which gcov writes from them, each
    // with its directories beneath gcov/out.
    private async counters(project: LoadedProject): Promise<Array<{ file: string, segments: string[] }>> {
        const directory = this.countersDirectory(project);
        const files = await this.reads.run(() => this.fs.listFiles(directory));
        return files.filter((file) => /\.(gcda|gcov)$/.test(file))
            .map((file) => ({ file, segments: this.paths.relative(directory, this.paths.dirname(file)).split(/[\\/]/) }));
    }

    // Why a project can't give coverage at all, or undefined when it can.
    private coverageConfigurationProblem(project: LoadedProject): string | undefined {
        const coverage = project.state.coverage;
        return coverage === undefined
            ? `Ceedling project '${project.key}' doesn't enable the gcov plugin, so its tests ran without coverage.`
            : coverageProblem(project.key, coverage);
    }

    // The first Cobertura report present, with each file at its candidate path that exists. Ceedling
    // runs the coverage tools in the project directory, which relative report paths start from.
    private async readCoverage(project: LoadedProject): Promise<CoverageOutcome> {
        const problem = this.coverageConfigurationProblem(project);
        if (problem !== undefined) {
            return { kind: 'missing', message: problem };
        }
        const reportPaths = this.coberturaPaths(project);
        const reportPath = await this.firstPresent(reportPaths);
        if (reportPath === undefined) {
            return {
                kind: 'missing',
                message: `Ceedling project '${project.key}' wrote no coverage report at ${reportPaths.join(' or ')}. ` +
                    `Check that gcovr or ReportGenerator runs in the configured shell. Ceedling's output in the Test Results panel says more.`,
            };
        }
        try {
            const report = await parseCoberturaReport(await this.reads.run(() => this.fs.readFile(reportPath)));
            // A file keeps its candidate that exists, else its first. A sole candidate needs no check.
            const files = await Promise.all(reportedFiles(report, project.absPath, this.paths).map(async ({ candidates, lines, functions }) =>
                ({ path: (candidates.length > 1 ? await this.firstPresent(candidates) : undefined) ?? candidates[0] ?? '', lines, functions })));
            if (files.length === 0) {
                return {
                    kind: 'missing',
                    message: `The coverage report '${reportPath}' covers no source files. gcovr reports only sources beneath :gcov: ↳ :gcovr: ↳ :report_root:, ` +
                        `the project directory by default.`,
                };
            }
            return { kind: 'report', path: reportPath, files };
        } catch (e) {
            return { kind: 'missing', message: `Could not read the coverage report '${reportPath}': ${util.format(e)}` };
        }
    }

    private async firstPresent(filePaths: string[]): Promise<string | undefined> {
        const present = await Promise.all(filePaths.map((filePath) => this.fs.exists(filePath)));
        return filePaths.find((_, i) => present[i]);
    }

    // The newer report, when a run such as `test:x gcov:x` wrote both.
    private async readReport(project: LoadedProject): Promise<CppUnitReport | undefined> {
        const reportPaths = this.reportPaths(project);
        const mtimes = await Promise.all(reportPaths.map((reportPath) => this.fs.mtimeMs(reportPath)));
        const [newest] = reportPaths
            .map((reportPath, i) => ({ reportPath, mtime: mtimes[i] }))
            .filter((r): r is { reportPath: string, mtime: number } => r.mtime !== undefined)
            .sort((a, b) => b.mtime - a.mtime);
        if (!newest) {
            this.logger.debug(`readReport(${project.key}): Ceedling produced no CppUnit report`);
            return undefined;
        }
        try {
            return await parseCppUnitReport(await this.reads.run(() => this.fs.readFile(newest.reportPath)));
        } catch (e) {
            this.logger.warn(`readReport(${project.key}): could not read '${newest.reportPath}': ${util.format(e)}`);
            return undefined;
        }
    }

    private async runInEveryProject(args: string[], token?: Cancellation): Promise<boolean> {
        const results = await mapGrouped(this.candidates, (project) => this.directoryOf(project),
            (project) => this.exclusively(project, () => this.ceedling(args, { project, cancellation: token })));
        return results.every((result) => !result.error || result.cancelled);
    }

    // `${TEST_ID}` in each configured argument becomes the test file: its project-relative path
    // where Ceedling accepts one, which tells same-named files apart, else its name alone.
    // `testCaseFilter` appends Ceedling's --test-case flag, which enables the runner's command-line
    // arguments itself.
    // A coverage run in a project with the gcov plugin uses `coverageCommandArgs`. Before 1.2.1,
    // Ceedling's gcov: task prepends the test file prefix to a name lacking it, so it takes only the
    // bare file name, which can't tell same-named test files apart. Reports deferred to the
    // report:gcov task are generated in the same run.
    private commandArgs(project: LoadedProject, testId: string, mode: RunMode, testCaseFilter?: string): string[] {
        const coverage = mode.kind === 'coverage' ? project.state.coverage : undefined;
        const byPath = coverage ? project.capabilities.pathQualifiedCoverageTasks : project.capabilities.pathQualifiedTestTasks;
        const testFile = byPath ? testId : this.paths.basename(testId.replace(/\\/g, '/'));
        if (coverage && !byPath) {
            const namesakes = project.files.filter((f) => f.id !== testId && this.paths.basename(f.id.replace(/\\/g, '/')) === testFile);
            if (namesakes.length > 0) {
                // A Ceedling that resolves test: tasks by path refuses the bare name as ambiguous.
                this.logger.warn(`A coverage run of '${testId}' names it '${testFile}', which Ceedling ${project.release} can't tell apart from ` +
                    `${namesakes.map((f) => `'${f.id}'`).join(', ')}. ` +
                    (project.capabilities.pathQualifiedTestTasks ? 'It stops with an ambiguous file reference error. ' : 'It may run the other file. ') +
                    `Ceedling ${firstRelease('pathQualifiedCoverageTasks')} and later take its path.`);
            }
        }
        const args = this.getConfiguration()
            .get<string[]>(coverage ? 'coverageCommandArgs' : 'testCommandArgs', [coverage ? 'gcov:${TEST_ID}' : 'test:${TEST_ID}'])
            .map((arg) => arg.replaceAll('${TEST_ID}', testFile));
        if (coverage?.reportTask && !args.includes('report:gcov')) {
            args.push('report:gcov');
        }
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
