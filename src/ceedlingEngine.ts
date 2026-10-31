// Orchestrates Ceedling for one workspace folder: discovering its projects and tests, running
// them, building a test for the debugger, and cleaning. Each concern lives in its own module. This
// class sequences them and owns the per-folder state.
//
// - ceedlingProjectConfig: settings → projects, and resolved configuration → ProjectState
// - ceedlingProcess: running Ceedling, with per-run cancellation
// - unityTestDiscovery: test functions and cases in source, named as Ceedling names them
// - testResults: the CppUnit report mapped onto discovered ids
//
// It has no `vscode` dependency, not even for types. Settings, the diagnostics sink, the runner,
// and the filesystem come in through `deps`, so the unit tests drive it with fakes.

import crypto from 'crypto';
import yaml from 'js-yaml';
import os from 'os';
import util from 'util';
import { type BuildOutcome, reportOf, reportResults, transcriptOf } from './buildReporting';
import { buildPath, type Candidates, chooseExecutable, cppunitReportPaths, executablePlace, ownOrUnclaimed, projectBuildName, TEST_OUTPUT } from './buildLayout';
import { buildProjectArgs, DEBUG_VERBOSITY, taskArgs } from './ceedlingCommandLine';
import {
    detectLayoutUpgrade,
    exceptionOf,
    extractTestFunctionName,
    parseFileListBullets,
    testCaseFilterMatchedExactly,
    withException,
} from './ceedlingOutputParsing';
import { buildCommandLine, type Cancellation, type CeedlingResult, CeedlingRunner } from './ceedlingProcess';
import {
    ALTERNATE_DEFAULT_PROJECT_FILE,
    CeedlingLoadError,
    type CeedlingProject,
    DEFAULT_CPPUNIT_REPORT_FILENAME,
    DEFAULT_PROJECT_FILE,
    isLoaded,
    isMixinFile,
    type LoadedProject,
    projectsFromSettings,
    type ProjectState,
    projectState,
} from './ceedlingProjectConfig';
import { type CeedlingCapabilities, checkVersion, type ProjectCeedling, releaseKnown, VENDORED_CEEDLING, type VersionCheck } from './ceedlingVersions';
import { KeyedLock, Limiter, mapGrouped } from './concurrency';
import { clearTestCounters, coverageConfigurationProblem, prepareCoverage, readCoverage, type RunMode, TEST_MODE } from './coverageRun';
import { type DiagnosticsSink } from './diagnosticsStore';
import { deleteFiles, type EngineFileSystem, type EngineIo, nodeFileSystem, readText } from './engineFileSystem';
import type { Log } from './log';
import { pathKey, type PlatformPaths, pathsFor } from './platformPaths';
import { type MatchedProblem, matchProblems } from './problemMatching';
import { setting, SETTING_DEFAULTS, type SettingKey, type Settings, type SettingsSource } from './settings';
import { allIds, type CeedlingFileNode, type CeedlingProjectNode, type CeedlingTestFunction, functionIds, leafIds, type RunReporter } from './testModel';
import { type CppUnitReport, parseCppUnitReport, reportedNames } from './testResults';
import { testFileNodes } from './testFileNodes';

export { CeedlingLoadError } from './ceedlingProjectConfig';

// A vendored Ceedling's own version, relative to the project directory.
const VENDORED_VERSION = `${VENDORED_CEEDLING}/lib/version.rb`;
// Enough to overlap file reads, few enough to stay clear of file descriptor limits.
const MAX_CONCURRENT_READS = 16;

export type EngineDeps = {
    // The folder's settings as they stand, read afresh for each use.
    settings: () => SettingsSource,
    diagnostics: DiagnosticsSink,
    // The extension's own mixin enabling the CppUnit report. It is always the last --mixin flag.
    bundledMixinPath: string,
    runner?: CeedlingRunner,
    fileSystem?: EngineFileSystem,
    platform?: NodeJS.Platform,
    tmpdir?: string,
    // Offers a clobber once Ceedling reports a project's build moved to a new layout.
    onLayoutUpgrade?: (upgrade: LayoutUpgrade) => void,
    // Finds the problems in a run's output. Tests stand in their own.
    matchProblems?: typeof matchProblems,
};

// A project whose build Ceedling moved to a new layout, leaving the old layout's output behind,
// and the notice that says what that means for it.
export type LayoutUpgrade = { projectKey: string, message: string };

// What a discovery command found, or Ceedling's exception when it failed, if it gave one.
type Found<T> = { found: T } | { failed: string | undefined };

// A failed command, with Ceedling's own exception if it gave one.
function failure(result: CeedlingResult): { failed: string | undefined } {
    return { failed: exceptionOf(result) };
}

type LoadOutcome =
    | { kind: 'loaded', project: LoadedProject }
    | { kind: 'error', message: string }
    | { kind: 'unusable', error: unknown };

// What a run compiled. A file run's diagnostics replace only that file's, a project run's all.
// `recount` clears the file's coverage counters first, under the build's own locks, for a rerun
// whose earlier attempt counted some of its tests.
type RunScope = { kind: 'project' } | { kind: 'file', file: CeedlingFileNode, recount?: boolean };

// Diagnostics are kept per project for project runs, and per file for file and function runs. A
// file's id joins its project's key with a character no setting or path holds, so no project's
// ids begin with another's, e.g. `fw` and `fw::sim`.
export function fileDiagnosticsId(projectKey: string, fileId: string): string {
    return `${projectKey}\0${fileId}`;
}

function isFileDiagnosticsIdIn(projectKey: string, id: string): boolean {
    return id.startsWith(`${projectKey}\0`);
}

export class CeedlingEngine {

    private readonly settings: () => SettingsSource;
    private readonly diagnostics: DiagnosticsSink;
    private readonly matchProblems: typeof matchProblems;
    private readonly bundledMixinPath: string;
    private readonly runner: CeedlingRunner;
    private readonly fs: EngineFileSystem;
    private readonly platform: NodeJS.Platform;
    // Path rules follow `platform` rather than the host's, as ceedlingProjectConfig's do.
    private readonly paths: PlatformPaths;
    private readonly tmpdir: string;
    // One build, clean, or clobber at a time per project directory and per build root. Builds
    // sharing a build root share its reports and counters. Discovery's commands queue too, unless
    // discovering() finds them read-only. Before 1.2.1 every command that loads a project rewrites
    // the Unity and CMock copies in its build root in place. That can corrupt a build it overlaps.
    // Work elsewhere proceeds independently. `ceedling version` needs no lock.
    private readonly locks = new KeyedLock();
    // The filesystem, with one read limit for every read the engine makes.
    private readonly io: EngineIo;

    // The last successful discovery. A failed discovery leaves it in place, so runs already under
    // way, and runs of the tree still on screen, keep their project arguments and directory.
    private projects = new Map<string, LoadedProject>();
    // Projects whose project file exists, as of the latest discovery attempt, failed or not. Their
    // files are watched, so fixing a broken configuration triggers the next discovery.
    private candidates: CeedlingProject[] = [];
    // One notification per project per session. A project.yml save rediscovers every time.
    private readonly warnedNonDefaultReportFilename = new Set<string>();
    // One offer per project per session. Ceedling warns for each cache it sets aside, so a later
    // coverage build warns again for the gcov cache.
    private readonly offeredClobbers = new Set<string>();
    private readonly onLayoutUpgrade: (upgrade: LayoutUpgrade) => void;

    // `folderPath` is the workspace folder's. Its settings and default project live there.
    constructor(
        private readonly folderPath: string,
        private readonly logger: Log,
        private readonly isDevelopmentMode: boolean,
        deps: EngineDeps,
    ) {
        this.settings = deps.settings;
        this.diagnostics = deps.diagnostics;
        this.matchProblems = deps.matchProblems ?? matchProblems;
        this.bundledMixinPath = deps.bundledMixinPath;
        this.runner = deps.runner ?? new CeedlingRunner();
        this.fs = deps.fileSystem ?? nodeFileSystem;
        this.platform = deps.platform ?? process.platform;
        this.paths = pathsFor(this.platform);
        this.tmpdir = deps.tmpdir ?? os.tmpdir();
        this.onLayoutUpgrade = deps.onLayoutUpgrade ?? (() => { /* nobody to offer a clobber to */ });
        this.io = { fs: this.fs, reads: new Limiter(MAX_CONCURRENT_READS), paths: this.paths, platform: this.platform, log: logger };
    }

    dispose(): void {
        this.cancel();
    }

    // Read when used, so a change applies from the next read.
    setting<K extends SettingKey>(key: K): Settings[K] {
        return setting(this.settings(), key);
    }

    getDebugLaunchConfig(projectKey: string): string {
        return this.project(projectKey).debugLaunchConfig;
    }

    // A gdb log reference in a crash message is relative to the project directory.
    getProjectAbsPath(projectKey: string): string {
        return this.project(projectKey).absPath;
    }

    // Every file a project's configuration can come from, whether or not it exists yet: both
    // default project files, any alternate project file, and each mixin given as a file path. A
    // vendored Ceedling's version file joins them, since vendoring or upgrading it changes the
    // Ceedling the project runs.
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
            [DEFAULT_PROJECT_FILE, ALTERNATE_DEFAULT_PROJECT_FILE, project.ymlFileName, ...project.mixins.filter(isMixinFile), VENDORED_VERSION]
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
        const [node] = await testFileNodes(this.io, project, [fileId], this.prettyLabels(), source);
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
        const outcomes = await this.perDirectory(this.candidates, (project) => this.loadProject(project));
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
        const listings = await this.perDirectory(projects, (project) => this.discovering(project, project, project.state, () => this.listTestFiles(project)));
        const unlisted = projects.flatMap((project, i) => {
            const listing = listings[i];
            return listing !== undefined && 'failed' in listing ? [{ project, exception: listing.failed }] : [];
        });
        if (unlisted.length > 0) {
            throw new CeedlingLoadError(unlisted.map(({ project, exception }) => withException(
                `Failed to list the test files of Ceedling project '${project.key}' with 'ceedling files:test'. ` +
                `Check that Ceedling runs in the configured shell (ceedlingExplorer.shellPath), and that the project's ` +
                `:paths: ↳ :test: entries are valid. The Ceedling Explorer log has Ceedling's output.`, exception)).join('\n'));
        }
        const labels = this.prettyLabels();
        await Promise.all(projects.map(async (project, i) => {
            const listing = listings[i];
            project.files = await testFileNodes(this.io, project, listing !== undefined && 'found' in listing ? listing.found : [], labels);
        }));
        this.projects = loaded;
        const diagnosticsIds = new Set([...loaded.values()].flatMap((p) => [p.key, ...p.files.map((f) => fileDiagnosticsId(p.key, f.id))]));
        this.diagnostics.retainIds((id) => diagnosticsIds.has(id));
        // Copies, so the caller's tree and the engine's change only as each changes its own.
        return [...loaded.values()].map((project) => ({ projectKey: project.key, label: project.key, files: [...project.files] }));
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
            functionIds(fn), leafIds([fn]), reporter, token, name,
        );
        if (outcome === 'collision') {
            this.logger.warn(
                `runFunction: --test-case=${name} also matched an unrelated test in '${file.id}'. ` +
                `Ceedling's filter is a substring match, not exact. Falling back to a full-file run.`
            );
            await this.runWholeFile(project, file, reporter, token, mode, true);
        }
    }

    // Runs a whole file on the project the caller started with. A rediscovery since may have
    // replaced or dropped it.
    private async runWholeFile(project: LoadedProject, file: CeedlingFileNode, reporter: RunReporter, token: Cancellation, mode: RunMode, recount = false): Promise<void> {
        await this.runTests(project, { kind: 'file', file, recount }, mode, this.commandArgs(project, file.id, mode), allIds(file), leafIds(file.functions), reporter, token);
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
            const build = reportOf(outcome, ids, leaves, reporter);
            if (build === undefined) {
                return undefined;
            }
            reportResults(build.report, leaves, build.transcript, reporter, this.logger);
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

    // A rediscovery may have dropped the project since its clobber was offered.
    async clobberProject(projectKey: string, token?: Cancellation): Promise<boolean> {
        const project = this.candidates.filter((candidate) => candidate.key === projectKey);
        if (project.length === 0) {
            this.logger.warn(`clobberProject: Ceedling project '${projectKey}' is no longer configured`);
            return false;
        }
        return this.runInEveryProject(['clobber'], token, project);
    }

    cancel(): void {
        this.runner.cancelAll();
    }

    private projectSettings(): Promise<CeedlingProject[]> {
        return projectsFromSettings(
            { projects: this.setting('projects'), mixins: this.setting('mixins') },
            this.folderPath, this.platform, (p) => this.fs.isDirectory(p), (p) => this.fs.exists(p),
        );
    }

    private prettyLabels(): { tests: boolean, files: boolean } {
        return { tests: this.setting('prettyTestLabel'), files: this.setting('prettyTestFileLabel') };
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

    // `work` for each project, concurrently across directories and in order within one, with the
    // results in the projects' order.
    private perDirectory<P extends CeedlingProject, R>(projects: readonly P[], work: (project: P) => Promise<R>): Promise<R[]> {
        return mapGrouped(projects, (project) => this.directoryOf(project), work);
    }

    // Runs work holding the project's locks: its directory's, and its build root's once a
    // discovery has resolved it. A rediscovery takes the build root the last discovery found,
    // which any build still running uses. A project no discovery has loaded yet holds only its
    // directory's, so before 1.2.1 its first dumpconfig can still rewrite a shared build root's
    // vendored sources under another project's build.
    private exclusively<T>(project: CeedlingProject, work: () => Promise<T>): Promise<T> {
        const loaded = isLoaded(project) ? project : this.projects.get(project.key);
        const buildRoot = loaded ? [`build:${pathKey(buildPath(loaded, this.paths), this.platform)}`] : [];
        return this.locks.runAll([`directory:${this.directoryOf(project)}`, ...buildRoot], work);
    }

    // Runs dumpconfig or files:test for discovery, without the project's locks where they write
    // nothing. Before Ceedling 1.2.1 both rewrite the build root's vendored sources, so they hold the
    // locks as builds do. From 1.2.1 they run alongside builds, cleans, and clobbers.
    // - `ceedling` comes from this discovery's version check. It counts only when that check showed
    //   its release exactly.
    // - It must also be the Ceedling the project runs. See releaseKnown().
    private discovering<T>(project: CeedlingProject, ceedling: ProjectCeedling, state: ProjectState | undefined, work: () => Promise<T>): Promise<T> {
        const writesNothing = ceedling.capabilities.readOnlyDiscovery && this.releaseKnown(project, ceedling, state);
        return writesNothing ? work() : this.exclusively(project, work);
    }

    // Checks one project's Ceedling and resolves its configuration. An unusable Ceedling stops all
    // discovery. A configuration problem is reported alongside any others.
    private async loadProject(project: CeedlingProject): Promise<LoadOutcome> {
        let check: VersionCheck;
        try {
            check = await checkVersion(project.key, (withProject) => this.ceedling(['version'], withProject ? { project } : { cwd: project.absPath }), this.logger);
        } catch (error) {
            return { kind: 'unusable', error };
        }
        if (check.kind === 'configuration') {
            return { kind: 'error', message: check.message };
        }
        if (check.kind === 'unusable') {
            return { kind: 'unusable', error: new CeedlingLoadError(check.message) };
        }
        if (check.warning !== undefined) {
            this.logger.warn(check.warning);
        }
        const { ceedling } = check;
        const { capabilities } = ceedling;
        if (project.ambiguousProjectFile && capabilities.ceedlingYml) {
            return {
                kind: 'error',
                message: `Both project.yml and ceedling.yml exist in ${project.absPath}, so Ceedling can't tell which is project '${project.key}'. ` +
                    `Remove or rename one, or name the one to use in ceedlingExplorer.projects[].path.`,
            };
        }
        // The last discovery's state is known only while the configuration it came from is unchanged.
        // Before 1.2.2, an edit that just selected another Ceedling is invisible to the version check.
        const configuration = await this.configurationFingerprint(project);
        const previous = this.projects.get(project.key);
        const known = previous?.configuration === configuration ? previous.state : undefined;
        const resolved = await this.discovering(project, ceedling, known, () => this.resolveConfig(project, capabilities));
        if ('failed' in resolved) {
            return {
                kind: 'error',
                message: withException(`Failed to resolve Ceedling's configuration for project '${project.key}' with 'ceedling dumpconfig'. ` +
                    `Check that Ceedling runs in the configured shell (ceedlingExplorer.shellPath), and that ` +
                    `ceedlingExplorer.projects, ceedlingExplorer.mixins, and any projects[].mixins name valid files and mixins.`, resolved.failed),
            };
        }
        const state = projectState(resolved.found, this.platform);
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
            readText(this.io, this.paths.resolve(project.absPath, file)).catch(() => null)));
        const parts = [project.absPath, project.projectFileName, project.ymlFileName, project.mixins, files, contents];
        return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    }

    // The project's fully merged configuration, from Ceedling itself: project file, mixins, and
    // plugin defaults, as a real build sees them. Ceedling 1.2.0 can write it to stdout. Earlier
    // versions write only to a file, so this goes through a uniquely named temporary file.
    private async resolveConfig(project: CeedlingProject, capabilities: CeedlingCapabilities): Promise<Found<unknown>> {
        if (capabilities.dumpconfigStdout) {
            const result = await this.ceedling(['dumpconfig', '--stdout'], { project });
            if (result.error) {
                this.logger.error(`resolveConfig(${project.key}): 'ceedling dumpconfig --stdout' failed: ${util.format(result)}`);
                return failure(result);
            }
            // The YAML starts at its `---` document marker. Anything Ceedling logs before it is skipped.
            const start = result.stdout.search(/^---\s*$/m);
            try {
                return { found: yaml.safeLoad(start >= 0 ? result.stdout.slice(start) : result.stdout) };
            } catch (e) {
                this.logger.error(`resolveConfig(${project.key}): could not parse dumpconfig output: ${util.format(e)}`);
                return { failed: undefined };
            }
        }
        // Ceedling may write part of the file before it fails, so the file goes either way.
        const outputPath = this.paths.join(this.tmpdir, `ceedling-dumpconfig-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
        try {
            const result = await this.ceedling(['dumpconfig', outputPath], { project });
            if (result.error) {
                this.logger.error(`resolveConfig(${project.key}): 'ceedling dumpconfig' failed: ${util.format(result)}`);
                return failure(result);
            }
            try {
                return { found: yaml.safeLoad(await readText(this.io, outputPath)) };
            } catch (e) {
                this.logger.error(`resolveConfig(${project.key}): could not read dumpconfig output '${outputPath}': ${util.format(e)}`);
                return { failed: undefined };
            }
        } finally {
            this.fs.unlink(outputPath).catch(() => { /* a leftover temporary file is harmless */ });
        }
    }

    // Offers one clobber per project, with a notice of what the old layout does to coverage. Reports
    // read every counter on disk, so the old layout's count unless a reset clears them first.
    private offerClobber(project: LoadedProject): void {
        if (this.offeredClobbers.has(project.key)) {
            return;
        }
        this.offeredClobbers.add(project.key);
        const lead = `Ceedling changed where project '${project.key}' builds its tests. Clobber to remove the output left in the old layout.`;
        const coverage = project.state.coverage === undefined ? undefined : this.resetsCounters()
            ? 'Coverage stays exact meanwhile, since its counters reset before each coverage run.'
            : 'Until then, coverage reports also count the old layout\'s counters, since ceedlingExplorer.coverageResetsCounters is off.';
        const message = coverage === undefined ? lead : `${lead} ${coverage}`;
        this.logger.warn(message);
        this.onLayoutUpgrade({ projectKey: project.key, message });
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

    // Callers gate its locks through discovering(). A failure is logged with Ceedling's output.
    private async listTestFiles(project: CeedlingProject): Promise<Found<string[]>> {
        const result = await this.ceedling(['files:test'], { project });
        if (result.error) {
            this.logger.error(`listTestFiles(${project.key}): 'ceedling files:test' failed: ${util.format(result)}`);
            return failure(result);
        }
        return { found: parseFileListBullets(result.stdout) };
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
            if (!outcome.cancelled && outcome.report !== undefined && testCaseFilter !== undefined &&
                !testCaseFilterMatchedExactly(testCaseFilter, reportedNames(outcome.report))) {
                return 'collision';
            }
            const build = reportOf(outcome, ids, leaves, reporter);
            if (build === undefined) {
                // The test errors explain a failed build, but not a configuration that can't give coverage.
                const problem = !outcome.cancelled && mode.kind === 'coverage' ? coverageConfigurationProblem(project) : undefined;
                if (problem !== undefined) {
                    reporter.coverage({ kind: 'missing', message: problem });
                }
                return 'done';
            }
            reportResults(build.report, leaves, build.transcript, reporter, this.logger);
            if (build.coverage) {
                reporter.coverage(build.coverage);
            }
            return 'done';
        });
    }

    // Runs Ceedling and gathers everything a run reports from. Stale reports are deleted first, so
    // a report left by an earlier run can't pass as this one's.
    // Callers hold the project's locks, so a coverage report read here is this build's.
    private async buildAndRun(project: LoadedProject, scope: RunScope, mode: RunMode, args: string[], reporter: RunReporter, token: Cancellation): Promise<BuildOutcome> {
        await deleteFiles(this.io, cppunitReportPaths(project, this.paths));
        if (mode.kind === 'coverage') {
            await prepareCoverage(this.io, project, mode.run, this.resetsCounters());
            if (scope.kind === 'file' && scope.recount === true && this.resetsCounters()) {
                // An unknown release's counters may sit in any layout's place.
                const places = ownOrUnclaimed(scope.file, project.files, (f, layout) => projectBuildName(project, f.id, this.platform, layout), this.releaseKnown(project, project, project.state));
                await clearTestCounters(this.io, project, places);
            }
        }
        // Delta builds reuse cached results unless told to rerun, while compilation stays
        // incremental either way. Before 1.2.1 their cache ignores the --test-case filter, so a
        // filtered run could report another run's tests. In every version the cache also ignores
        // deleted coverage counters, so a coverage run after a reset would report no coverage.
        const runArgs = project.capabilities.forceTestRerun ? [...args, '--force-test-rerun'] : args;
        const result = await this.ceedling(runArgs, { project, verbose: true, cancellation: token });
        // Ceedling warns as a build starts, and a stopped build still rewrites its cache.
        if (detectLayoutUpgrade(result.stdout) || detectLayoutUpgrade(result.stderr)) {
            this.offerClobber(project);
        }
        if (result.cancelled || token.isCancellationRequested) {
            return { cancelled: true };
        }
        const transcript = transcriptOf(result);
        reporter.appendOutput(transcript.replace(/\n/g, '\r\n'));
        const exception = exceptionOf(result);
        const diagnostics = this.updateDiagnostics(project, scope, result);
        const coverage = mode.kind === 'coverage' ? await readCoverage(this.io, project) : undefined;
        return { cancelled: false, transcript, exception, diagnostics, report: await this.readReport(project), coverage };
    }

    // A project run supersedes every per-file entry in the project. A file run replaces its own
    // entry and drops the project entry's diagnostics in that file, which it just rebuilt. A build
    // that outlived a rediscovery dropping its project or file publishes nothing. A rediscovery never
    // takes a dropped project's locks, and from Ceedling 1.2.1 often none of its own.
    private updateDiagnostics(project: LoadedProject, scope: RunScope, result: CeedlingResult): MatchedProblem[] {
        const diagnostics = this.matchProblems(result, project.absPath, this.setting('problemMatching.mode'), this.setting('problemMatching.patterns'), this.logger, this.paths);
        const current = this.projects.get(project.key);
        if (current === undefined || (scope.kind === 'file' && !current.files.some((f) => f.id === scope.file.id))) {
            return diagnostics;
        }
        if (scope.kind === 'project') {
            this.diagnostics.retainIds((id) => !isFileDiagnosticsIdIn(project.key, id));
            this.diagnostics.set(project.key, diagnostics);
        } else {
            const testFile = this.keyOfPath(this.paths.resolve(scope.file.absPath));
            this.diagnostics.set(fileDiagnosticsId(project.key, scope.file.id), diagnostics);
            this.diagnostics.retain(project.key, (d) => this.keyOfPath(this.paths.resolve(d.file)) !== testFile);
        }
        return diagnostics;
    }

    // Where the file's executable may sit under Ceedling's test output directory, its release's
    // layout first. A release known exactly says where. Otherwise it may be any release, so each
    // layout's place counts, unless it is another test file's own. See releaseKnown().
    private executableCandidates(project: LoadedProject, file: CeedlingFileNode): Candidates {
        return ownOrUnclaimed(file, project.files, (f, layout) => executablePlace(project, f.id, this.platform, layout), this.releaseKnown(project, project, project.state));
    }

    private releaseKnown(project: CeedlingProject, ceedling: ProjectCeedling, state: ProjectState | undefined): boolean {
        return releaseKnown(ceedling, project.absPath, state?.whichCeedling, this.platform);
    }

    private executableTimes(project: LoadedProject, candidates: readonly string[]): Promise<Array<number | undefined>> {
        const outputDirectory = buildPath(project, this.paths, TEST_OUTPUT);
        return Promise.all(candidates.map((candidate) => this.fs.mtimeMs(this.paths.resolve(outputDirectory, candidate))));
    }

    // The executable's path under Ceedling's test output directory. See chooseExecutable().
    private async executableSubpath(project: LoadedProject, file: CeedlingFileNode, candidates: Candidates, before: ReadonlyArray<number | undefined>): Promise<string> {
        const { chosen, found } = chooseExecutable(before, await this.executableTimes(project, candidates));
        if (!found) {
            this.logger.warn(`executableSubpath: no built executable for '${file.id}' at '${candidates[0]}' under ${buildPath(project, this.paths, TEST_OUTPUT)}`);
        } else if (chosen > 0) {
            this.logger.warn(`executableSubpath: '${file.id}' built at '${candidates[chosen]}', not at '${candidates[0]}', where Ceedling ${project.release} would build it`);
        }
        return candidates[chosen] ?? candidates[0];
    }

    private resetsCounters(): boolean {
        return this.setting('coverageResetsCounters');
    }

    // The newer report, when a run such as `test:x gcov:x` wrote both.
    private async readReport(project: LoadedProject): Promise<CppUnitReport | undefined> {
        const reportPaths = cppunitReportPaths(project, this.paths);
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
            return await parseCppUnitReport(await readText(this.io, newest.reportPath));
        } catch (e) {
            this.logger.warn(`readReport(${project.key}): could not read '${newest.reportPath}': ${util.format(e)}`);
            return undefined;
        }
    }

    private async runInEveryProject(args: string[], token?: Cancellation, projects = this.candidates): Promise<boolean> {
        const results = await this.perDirectory(projects, (project) => this.exclusively(project, () => this.ceedling(args, { project, cancellation: token })));
        return results.every((result) => !result.error || result.cancelled);
    }

    // A test file's tasks, or `all`'s, from the configured arguments. See taskArgs().
    private commandArgs(project: LoadedProject, testId: string, mode: RunMode, testCaseFilter?: string): string[] {
        const coverage = mode.kind === 'coverage' ? project.state.coverage : undefined;
        const { args, warning } = taskArgs(project, testId, coverage, this.setting(coverage ? 'coverageCommandArgs' : 'testCommandArgs'), testCaseFilter, this.paths);
        if (warning !== undefined) {
            this.logger.warn(warning);
        }
        return args;
    }

    // `project` adds its --project/--mixin flags and runs in its directory. `verbose` adds
    // DEBUG_VERBOSITY in development mode only, so it never ships to a Marketplace install.
    private async ceedling(
        args: string[],
        options: { project?: CeedlingProject, cwd?: string, verbose?: boolean, cancellation?: Cancellation },
    ): Promise<CeedlingResult> {
        const fullArgs = [...args];
        if (options.project) {
            fullArgs.push(...buildProjectArgs(options.project.projectFileName, options.project.ymlFileName, options.project.mixins, this.bundledMixinPath));
        }
        const verbose = this.isDevelopmentMode && options.verbose === true;
        if (verbose) {
            fullArgs.push(...DEBUG_VERBOSITY);
        }
        const cwd = options.cwd ?? options.project?.absPath ?? this.folderPath;
        const command = this.setting('ceedlingCommand').trim() || SETTING_DEFAULTS.ceedlingCommand;
        const shellSetting = this.setting('shellPath');
        const shell = shellSetting && shellSetting !== 'null' ? shellSetting : undefined;
        this.logger.debug(`ceedling: ${buildCommandLine(command, fullArgs)} (cwd=${cwd}, shell=${shell ?? 'default'})`);
        const result = await this.runner.run({
            command,
            args: fullArgs,
            cwd,
            shell,
            stripAnsi: this.setting('ansiEscapeSequencesRemoved'),
            cancellation: options.cancellation,
        });
        if (verbose) {
            this.logger.debug(transcriptOf(result));
        }
        return result;
    }
}
