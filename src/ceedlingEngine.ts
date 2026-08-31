import { Mutex } from 'async-mutex';
import child_process from 'child_process';
import deepmerge from 'deepmerge';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import semver from 'semver';
import stripAnsi from 'strip-ansi';
import tree_kill from 'tree-kill';
import util from 'util';
import vscode from 'vscode';
import xml2js from 'xml2js';
import {
    buildFileLabelRegex,
    buildTestFunctionRegex,
    buildTestLabelRegex,
    expandParametrizedTestCases,
    extractTestFunctionName,
    normalizeMultilineFunctionName,
    parseCeedlingVersionString,
    parseFileListBullets,
    testCaseFilterMatchedExactly,
} from './ceedlingOutputParsing';
import { getTestListFromXmlReport } from './ceedlingXmlReport';
import { Logger } from './logger';
import { FileDiagnostic, ProblemMatcher, ProblemMatchingPattern } from './problemMatcher';

const MINIMUM_CEEDLING_VERSION = '1.0.0';
const TEST_VERBOSITY_FLAG = '--verbosity debug';

export type ProjectData = {
    projectPath: string,
    ymlFileName: any,
    absPath: string,
    debugLaunchConfig: string,
    files: {
        assembly?: string[],
        header?: string[],
        source?: string[],
        test?: string[],
    }
}

export type ProjectConfig = {
    path: string,
    debugLaunchConfig: string,
    name?: string,
}

export type CeedlingTestCase = {
    id: string,
    label: string,
    line: number,
}

export type CeedlingTestFunction = {
    id: string,
    label: string,
    line: number,
    cases: CeedlingTestCase[],
}

export type CeedlingFileNode = {
    id: string,
    label: string,
    absPath: string,
    projectKey: string,
    functions: CeedlingTestFunction[],
}

export type CeedlingProjectNode = {
    projectKey: string,
    label: string,
    files: CeedlingFileNode[],
}

// Thrown when discovery cannot proceed (bad Ceedling version, sanity check failure).
// A workspace folder with no Ceedling project at all is *not* an error - see discover().
export class CeedlingLoadError extends Error { }

export interface RunReporter {
    started(id: string): void;
    passed(id: string, message?: string): void;
    failed(id: string, message: string, line?: number): void;
    skipped(id: string, message?: string): void;
    // `location`, when given, is the compiler diagnostic that best explains why no XML report
    // was produced. It names its own file, not necessarily the file being tested (e.g. a bad
    // header).
    errored(id: string, message: string, location?: { file: string, line: number }): void;
    appendOutput(text: string): void;
}

// Every id (file, parametrized-function group, and case) contained in a file, used to mark
// everything as started before a run and as errored if Ceedling never produced a report.
function getAllIds(file: CeedlingFileNode): string[] {
    const ids = [file.id];
    for (const fn of file.functions) {
        ids.push(fn.id);
        for (const testCase of fn.cases) {
            ids.push(testCase.id);
        }
    }
    return ids;
}

export class CeedlingEngine {

    private ceedlingVersionChecked = false;
    private ceedlingProcess: child_process.ChildProcess | undefined;
    private ceedlingMutex: Mutex = new Mutex();

    // mapped to the project key
    private functionRegexps: Record<string, RegExp | undefined> = {};
    private fileLabelRegexps: Record<string, RegExp | undefined> = {};
    private testLabelRegexps: Record<string, RegExp | undefined> = {};
    private buildDirectories: Record<string, string> = {};
    private reportFilenames: Record<string, string> = {};

    private isPrettyTestLabelEnable: boolean = false;
    private isPrettyTestFileLabelEnable: boolean = false;

    private projectData: Record<string, ProjectData> = {};

    readonly problemMatcher: ProblemMatcher;

    constructor(
        public readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly logger: Logger,
        private readonly isDevelopmentMode: boolean,
    ) {
        this.problemMatcher = new ProblemMatcher(logger);
    }

    dispose(): void {
        this.cancel();
        this.problemMatcher.dispose();
    }

    getConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('ceedlingExplorer', this.workspaceFolder.uri);
    }

    getDebugLaunchConfig(projectKey: string): string {
        return this.projectData[projectKey].debugLaunchConfig;
    }

    // A gdb log file reference in a crash message is relative to the project directory. A
    // caller turning that reference into a clickable link needs this to resolve it.
    getProjectAbsPath(projectKey: string): string {
        return this.projectData[projectKey].absPath;
    }

    // Discover every configured project and its test files/functions.
    // Throws CeedlingLoadError if Ceedling itself can't be used at all (bad version, no
    // project.yml can be read for any configured project, missing cppunit report plugin).
    // A workspace folder with no Ceedling project present is reported as zero projects,
    // not an error - see loadProjectPaths().
    async discover(): Promise<CeedlingProjectNode[]> {
        this.ceedlingVersionChecked = false;
        this.loadProjectPaths();

        const projectKeys = this.getExistingProjectKeys();
        if (projectKeys.length === 0) {
            this.logger.debug(`No Ceedling project.yml found under ${this.workspaceFolder.uri.fsPath}, skipping`);
            return [];
        }

        await this.checkCeedlingVersion();

        for (const projectKey of projectKeys) {
            const ymlProjectData = await this.getYmlProjectData(projectKey);
            this.logger.debug(`discover(projectKey=${projectKey}, ymlProjectData=${util.format(ymlProjectData)})`);
            this.setBuildDirectory(projectKey, ymlProjectData);
            this.setXmlReportPath(projectKey, ymlProjectData);
            this.setFunctionRegex(projectKey, ymlProjectData);
            this.setFileLabelRegex(projectKey, ymlProjectData);
            this.setTestLabelRegex(projectKey, ymlProjectData);
        }

        const errorMessage = await this.sanityCheck(projectKeys);
        if (errorMessage) {
            throw new CeedlingLoadError(errorMessage);
        }

        this.isPrettyTestFileLabelEnable = this.getConfiguration().get<boolean>('prettyTestFileLabel', false);
        this.isPrettyTestLabelEnable = this.getConfiguration().get<boolean>('prettyTestLabel', false);

        const projects: CeedlingProjectNode[] = [];
        for (const projectKey of projectKeys) {
            const testFiles = await this.getFileListFromProject('test', projectKey);
            this.projectData[projectKey].files.test = testFiles;
            projects.push({
                projectKey,
                label: projectKey,
                files: Array.from(this.getTestFileNodes(projectKey, testFiles)),
            });
        }
        return projects;
    }

    getYmlProjectPaths(): string[] {
        return this.getExistingProjectKeys().map((projectKey) => this.getYmlProjectPath(projectKey));
    }

    async runFile(projectKey: string, file: CeedlingFileNode, reporter: RunReporter, token: vscode.CancellationToken): Promise<void> {
        await this.runInternal(projectKey, file.id, this.getTestCommandArgs(file.id), getAllIds(file), reporter, token);
    }

    async runProjectAll(projectKey: string, files: CeedlingFileNode[], reporter: RunReporter, token: vscode.CancellationToken): Promise<void> {
        const allIds = files.flatMap((file) => getAllIds(file));
        await this.runInternal(projectKey, projectKey, this.getTestCommandArgs('all'), allIds, reporter, token);
    }

    // Runs a single test function (and, if parametrized, all its cases together - Ceedling's
    // --test-case filter has function-level granularity only, it cannot isolate one case from
    // its siblings) instead of every test in the file. Ceedling still recompiles the whole file
    // regardless - --test-case narrows what runs and gets reported, not what gets built.
    async runFunction(
        projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction, reporter: RunReporter, token: vscode.CancellationToken
    ): Promise<void> {
        const functionName = extractTestFunctionName(fn.id);
        const ids = [fn.id, ...fn.cases.map((c) => c.id)];
        const collided = await this.runInternal(
            projectKey, fn.id, this.getTestCommandArgs(file.id, functionName), ids, reporter, token, functionName
        );
        if (collided) {
            this.logger.warn(
                `runFunction: --test-case=${functionName} also matched an unrelated test in '${file.id}' - ` +
                `Ceedling's filter is a substring match, not exact. Falling back to a full-file run.`
            );
            await this.runFile(projectKey, file, reporter, token);
        }
    }

    // Returns true when a `testCaseFilter` run's results include a test that doesn't actually
    // belong to the requested function - Ceedling's --test-case filter matches by substring, so
    // a short function name can accidentally also match a longer, unrelated one. The caller
    // decides what to do about it; this makes no reporter calls in that case.
    private async runInternal(
        projectKey: string, diagnosticsId: string, args: string[], allIds: string[], reporter: RunReporter, token: vscode.CancellationToken,
        testCaseFilter?: string
    ): Promise<boolean> {
        for (const id of allIds) {
            reporter.started(id);
        }
        const release = await this.ceedlingMutex.acquire();
        try {
            if (token.isCancellationRequested) {
                return false;
            }
            await this.deleteXmlReport(projectKey);
            const result = await this.execCeedling(args, projectKey, TEST_VERBOSITY_FLAG);
            // Each section only appears when it has content. An empty stdout (e.g. a compile
            // failure that only wrote to stderr) otherwise left a bare, empty "stdout:" line
            // leading every message. That empty line showed as an empty label wherever this
            // message was previewed, not as a real error.
            const message = [
                result.stdout.length != 0 ? `stdout:\n${result.stdout}` : undefined,
                result.stderr.length != 0 ? `stderr:\n${result.stderr}` : undefined,
            ].filter((section): section is string => section !== undefined).join('\n');
            reporter.appendOutput(message.replace(/\n/g, '\r\n'));

            // absPath, not projectPath - compiler diagnostics report a path relative to the
            // project directory, and Uri.file() needs an absolute path to match the actually
            // open document. A relative prefix here left diagnostics visible in the Problems
            // panel but never as inline editor squiggles.
            const diagnostics = this.problemMatcher.scan(diagnosticsId, result.stdout, result.stderr, this.projectData[projectKey].absPath,
                this.getConfiguration().get<string>('problemMatching.mode', ""),
                this.getConfiguration().get<ProblemMatchingPattern[]>('problemMatching.patterns', []));

            const xmlReportData = await this.getXmlReportData(projectKey);
            this.logger.debug(`xmlReportData=${util.format(xmlReportData)}`);
            if (xmlReportData === undefined) {
                // The report was never produced. Lead with the compiler's own diagnostic, when
                // problem matching found one. reporter.failed already gives a real test failure
                // this same treatment, below. The full stdout/stderr transcript still follows
                // either way. Problem matching's patterns are compiler-oriented. They find no
                // diagnostic for a Ruby/Ceedling encoding exception. That case falls back to the
                // raw transcript alone.
                const leadDiagnostic = this.mostSevereDiagnostic(diagnostics);
                const erroredMessage = leadDiagnostic ? `${leadDiagnostic.diagnostic.message}\n\n${message}` : message;
                const location = leadDiagnostic
                    ? { file: leadDiagnostic.file, line: leadDiagnostic.diagnostic.range.start.line }
                    : undefined;
                for (const id of allIds) {
                    reporter.errored(id, erroredMessage, location);
                }
                return false;
            }

            const ignoredTests = this.getTestListDataFromXmlReport(xmlReportData, "IgnoredTests");
            const successfulTests = this.getTestListDataFromXmlReport(xmlReportData, "SuccessfulTests");
            const failedTests = this.getTestListDataFromXmlReport(xmlReportData, "FailedTests");

            if (testCaseFilter !== undefined) {
                const reportedNames = [...ignoredTests, ...successfulTests, ...failedTests].map((t) => t["Name"]);
                if (!testCaseFilterMatchedExactly(testCaseFilter, reportedNames)) {
                    return true;
                }
            }

            for (const ignoredTest of ignoredTests) {
                reporter.skipped(ignoredTest["Name"], message);
            }
            for (const successfulTest of successfulTests) {
                reporter.passed(successfulTest["Name"], message);
            }
            for (const failedTest of failedTests) {
                reporter.failed(
                    failedTest["Name"],
                    `${failedTest["Message"]}\n\n${message}`,
                    parseInt(failedTest["Location"]["Line"]) - 1,
                );
            }
            return false;
        } finally {
            release();
        }
    }

    // Compiles the test file and resolves the relative path to its built executable
    // (e.g. "test_foo/test_foo.out"), for the caller to splice into the user's debug launch
    // config. Returns undefined if compilation failed (message already reported via `reporter`).
    async compileForDebug(projectKey: string, file: CeedlingFileNode, reporter: RunReporter): Promise<string | undefined> {
        this.logger.debug(`compileForDebug(${projectKey}, ${file.id})`);
        reporter.started(file.id);
        const args = this.getTestCommandArgs(file.id);
        // Same signal runInternal already relies on: a real compile/link failure means Ceedling
        // never got far enough to produce a report, regardless of exit code - `ceedling
        // test:<file>` builds *and executes* the test, so a build that succeeds but has a failing
        // assertion also exits non-zero, and its executable is still fine to debug. Delete any
        // stale report first so a leftover report from a prior run can't be mistaken for this one.
        await this.deleteXmlReport(projectKey);
        const result = await this.execCeedling(args, projectKey, TEST_VERBOSITY_FLAG);
        const xmlReportData = await this.getXmlReportData(projectKey);
        if (xmlReportData === undefined) {
            reporter.failed(file.id, `${result.stdout}\n${result.stderr}`);
            return undefined;
        }
        const ymlProjectData = await this.getYmlProjectData(projectKey);
        const ext = this.getExecutableExtension(ymlProjectData);
        const testFileName = `${/([^/]*).c$/.exec(file.id)![1]}`;
        return `${testFileName}/${testFileName}${ext}`;
    }

    async clean(): Promise<{ error: any }[]> {
        return Promise.all(this.execCeedlingAllProjects(["clean"]));
    }

    async clobber(): Promise<{ error: any }[]> {
        return Promise.all(this.execCeedlingAllProjects(["clobber"]));
    }

    cancel(): void {
        this.logger.trace(`cancel()`);
        if (this.ceedlingProcess !== undefined) {
            if (this.ceedlingProcess.pid) {
                tree_kill(this.ceedlingProcess.pid);
            }
        }
    }

    private async checkCeedlingVersion(): Promise<void> {
        const version = await this.getCeedlingVersion();
        this.logger.debug(`checkCeedlingVersion()=${version}`);
        this.ceedlingVersionChecked = true;
        if (semver.lt(version, MINIMUM_CEEDLING_VERSION)) {
            throw new CeedlingLoadError(
                `Ceedling version ${version} is not supported. This extension requires Ceedling version ` +
                `${MINIMUM_CEEDLING_VERSION} or higher. Please upgrade your Ceedling installation.`
            );
        }
    }

    private async sanityCheck(projectKeys: string[]): Promise<string | void> {
        const sanityCheckErrors: string[] = [];
        const release = await this.ceedlingMutex.acquire();
        try {
            const result = await this.execCeedling([`summary`], projectKeys[0]);
            if (result.error) {
                return `Ceedling failed to run in the configured shell. ` +
                    'Please check if you can run `ceedling summary` in your shell.\n' +
                    `Please check the ceedlingExplorer.shellPath option.\n` +
                    `${result.stdout}\n${result.stderr}`
            }
        } finally {
            release();
        }
        for (const key of projectKeys) {
            const error = await this.checkYmlProjectData(key);
            if (error) {
                sanityCheckErrors.push(error);
            }
        }
        if (sanityCheckErrors.length > 0) {
            return sanityCheckErrors.join('\n');
        }
    }

    private async checkYmlProjectData(projectKey: string): Promise<string | void> {
        const ymlProjectData = await this.getYmlProjectData(projectKey)
        if (!ymlProjectData) {
            return `Failed to find or load the project.yml file for ${projectKey}. ` +
                `Please check the ceedlingExplorer.projectPath option.`;
        }
        try {
            if (!ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory')) {
                throw 'Report tests log factory plugin not enabled';
            }
        } catch (e) {
            return `The required Ceedling plugin 'report_tests_log_factory' is not enabled. ` +
                `You have to edit ${this.getYmlProjectPath(projectKey)} file to enable the plugin.\n` +
                `see https://github.com/ThrowTheSwitch/Ceedling/blob/master/plugins/report_tests_log_factory/README.md`;
        }
    }

    private getShellPath(): string | undefined {
        const shellPath = this.getConfiguration().get<string>('shellPath', 'null');
        return shellPath !== "null" ? shellPath : undefined;
    }

    // Returns the configured project keys whose project.yml actually exists on disk, skipping
    // (quietly, at debug level) any that don't - e.g. a multi-root workspace folder that isn't
    // itself a Ceedling project. A folder with none of its configured projects present yields [].
    private getExistingProjectKeys(): string[] {
        return Object.keys(this.projectData).filter((projectKey) => {
            const ymlPath = this.getYmlProjectPath(projectKey);
            if (!fs.existsSync(ymlPath)) {
                this.logger.debug(`No project.yml at '${ymlPath}' for project '${projectKey}', skipping`);
                return false;
            }
            return true;
        });
    }

    private loadProjectPaths(): void {
        const projectConfigs = this.getConfiguration().get<object>('projects', []) as Array<ProjectConfig>;
        this.projectData = {};
        let workspacePath = this.workspaceFolder.uri.fsPath;
        projectConfigs.forEach(projectConfig => {
            let ymlName = 'project.yml';
            let key = projectConfig.path;
            if (projectConfig.path.endsWith('.yml')) {
                const split = projectConfig.path.split('/');
                ymlName = split[split.length - 1];
                if (ymlName != 'project.yml') {
                    key = ymlName.replace('.yml', '');
                }
                projectConfig.path = projectConfig.path.replace(ymlName, '');
                if (projectConfig.path == '') {
                    projectConfig.path = '.';
                }
            }
            if (projectConfig.name) {
                key = projectConfig.name;
            }
            // Workaround: Uppercase disk letters are required on windows to be able to generate xml gcov reports
            if (process.platform == 'win32') {
                workspacePath = workspacePath.charAt(0).toUpperCase() + workspacePath.slice(1);
            }
            const absolutePath = path.resolve(workspacePath, projectConfig.path);
            if (!(fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory())) {
                throw new CeedlingLoadError(`The project path ${absolutePath} does not exist or is not a directory.`);
            } else {
                this.logger.debug(`loadProjectPaths: resolved project '${key}' -> path='${absolutePath}', ymlFileName='${ymlName}'`);
                this.projectData[key] = {
                    debugLaunchConfig: projectConfig.debugLaunchConfig,
                    projectPath: projectConfig.path,
                    ymlFileName: ymlName,
                    absPath: absolutePath,
                    files: {}
                };
            }
        });
        if (Object.keys(this.projectData).length == 0) {
            this.projectData['default'] = {
                debugLaunchConfig: 'ceedling',
                projectPath: ".",
                ymlFileName: 'project.yml',
                absPath: path.resolve(workspacePath, "."),
                files: {}
            };
        }
    }

    private async getFileListFromProject(fileType: string, projectKey: string): Promise<string[]> {
        const release = await this.ceedlingMutex.acquire();
        try {
            const result = await this.execCeedling([`files:${fileType}`], projectKey);
            if (result.error) {
                this.logger.error(`Failed to get the list of ${fileType} files: ${util.format(result)}`);
                return [];
            } else {
                return parseFileListBullets(result.stdout);
            }
        } finally {
            release();
        }
    }

    private getCeedlingCommand(args: ReadonlyArray<string>) {
        return `ceedling ${args.join(" ")}`;
    }

    // `testCaseFilter`, when given, appends Ceedling's --test-case flag to narrow the run to one
    // function (and, if parametrized, all its cases - see runFunction). Ceedling auto-enables
    // :test_runner: :cmdline_args itself when this flag is present; nothing here needs to.
    private getTestCommandArgs(testToExec: string, testCaseFilter?: string): Array<string> {
        // Keep only the filename of the test 'test/test_foo.c' -> 'test_foo.c'
        const testSuiteFilename = testToExec.replace(/^.*[\\/]/, "");
        const defaultTestCommandArgs = ["test:${TEST_ID}"];
        const args = this.getConfiguration()
            .get<Array<string>>('testCommandArgs', defaultTestCommandArgs)
            .map(x => x.replace("${TEST_ID}", testSuiteFilename));
        return testCaseFilter === undefined ? args : [...args, `--test-case=${testCaseFilter}`];
    }

    // Picks the diagnostic that best explains a compile failure. Patterns are evaluated
    // warning-then-error-then-catchall. The first entry in `diagnostics` is not reliably the
    // most severe one. An early warning can otherwise outrank the actual fatal error.
    private mostSevereDiagnostic(diagnostics: FileDiagnostic[]): FileDiagnostic | undefined {
        return diagnostics.slice().sort((a, b) => a.diagnostic.severity - b.diagnostic.severity)[0];
    }

    private getTestCaseMacroAliases(): Array<string> {
        return this.getConfiguration().get<Array<string>>('testCaseMacroAliases', ['TEST_CASE']);
    }

    private getTestRangeMacroAliases(): Array<string> {
        return this.getConfiguration().get<Array<string>>('testRangeMacroAliases', ['TEST_RANGE']);
    }

    private getExecutableExtension(ymlProjectData: any = undefined) {
        let ext = process.platform == 'win32' ? '.exe' : '.out';
        if (ymlProjectData) {
            try {
                const ymlProjectExt = ymlProjectData[':extension'][':executable'];
                if (ymlProjectExt != undefined) {
                    ext = ymlProjectExt;
                }
            } catch (e) {
                this.logger.debug(`getExecutableExtension: no ':extension'/':executable' in project.yml, using default '${ext}': ${e}`);
            }
        }
        return ext;
    }

    private async getCeedlingVersion(): Promise<string> {
        const result = await this.execCeedling(['version']);
        const version = parseCeedlingVersionString(result.stdout);
        if (version === undefined) {
            this.logger.error(`fail to get the ceedling version: ${util.format(result)}`);
            return '0.0.0';
        }
        return version;
    }

    private execCeedlingAllProjects(args: ReadonlyArray<string>): Promise<{ error: any }>[] {
        return this.getExistingProjectKeys().map((projectKey) => this.execCeedling(args, projectKey));
    }

    // `verbosity`, when non-empty, is literal flag text (e.g. '--verbosity debug') a call site
    // opts into splicing onto the command; it only takes effect in development mode (see
    // isDevelopmentMode below), so it never ships to users of a Marketplace install.
    private execCeedling(args: ReadonlyArray<string>, projectKey = Object.keys(this.projectData)[0], verbosity = ''): Promise<any> {
        let cwd = ".";
        if (this.ceedlingVersionChecked && projectKey in this.projectData) {
            let projectParam = ` --project project.yml`;
            if (this.projectData[projectKey].ymlFileName != 'project.yml') {
                projectParam += ` --mixin ${this.projectData[projectKey].ymlFileName}`;
            }
            args = [...args, projectParam];
            cwd = this.projectData[projectKey].absPath;
        }
        if (this.isDevelopmentMode && verbosity) {
            args = [...args, verbosity];
        }
        let command = this.getCeedlingCommand(args);
        const shell = this.getShellPath();
        this.logger.debug(`execCeedling(args=${util.format(args)}) \ncommand=${command} \ncwd=${cwd} \nshell=${shell}`);
        return new Promise<any>((resolve) => {
            this.ceedlingProcess = child_process.exec(
                command,
                {
                    cwd: cwd,
                    shell: shell,
                    // Ceedling's emoji/decorator output is unparseable-friendly noise for us and
                    // varies across versions (see CEEDLING_DECORATORS in Ceedling's own docs);
                    // force plain ASCII output so our parsing has a stable, version-independent
                    // surface to work against.
                    //
                    // Ceedling 1.0.0 crashes (a Ruby encoding exception) parsing non-ASCII source
                    // under a non-UTF-8 locale - confirmed empirically, and confirmed this forced
                    // override fixes it without needing any specific locale installed on the host.
                    // Ceedling 1.1.0 already handles this correctly regardless, so this is purely
                    // defensive for 1.0.0 users and has no effect on newer versions.
                    env: { ...process.env, CEEDLING_DECORATORS: 'false', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
                },
                (error, stdout, stderr) => {
                    const ansiEscapeSequencesRemoved = this.getConfiguration().get<boolean>('ansiEscapeSequencesRemoved', true);
                    if (ansiEscapeSequencesRemoved) {
                        stdout = stripAnsi(stdout);
                        stderr = stripAnsi(stderr);
                    }
                    if (this.isDevelopmentMode && verbosity) {
                        this.logger.debug(`stdout:\n${stdout}` + (stderr.length != 0 ? `\nstderr:\n${stderr}` : ``));
                    }
                    this.logger.debug(`exec done`);
                    resolve({ error, stdout, stderr });
                },
            )
        })
    }

    private getTestPrefix(ymlProjectData: any = undefined): string {
        let testPrefix = 'test|spec|should';
        if (ymlProjectData) {
            try {
                const ymlProjectUnityDefines = ymlProjectData[':unity'][':defines'];
                if (ymlProjectUnityDefines != undefined && (
                    ymlProjectUnityDefines.includes('-UNITY_SKIP_DEFAULT_RUNNER') ||
                    ymlProjectUnityDefines.includes('-RUN_TEST')
                )) {
                    const ymlProjectTestRunnerTestPrefix = ymlProjectData[':test_runner'][':test_prefix'];
                    if (ymlProjectTestRunnerTestPrefix != undefined) {
                        testPrefix = ymlProjectTestRunnerTestPrefix;
                    }
                } else {
                    const ymlProjectTestPrefix = ymlProjectData[':unity'][':test_prefix'];
                    if (ymlProjectTestPrefix != undefined) {
                        testPrefix = ymlProjectTestPrefix;
                    }
                }
            } catch (e) {
                this.logger.debug(`getTestPrefix: no ':unity'/':test_runner' data in project.yml, using default '${testPrefix}': ${e}`);
            }
        }
        return testPrefix;
    }

    private setFunctionRegex(projectKey: string, ymlProjectData: any = undefined) {
        const testPrefix = this.getTestPrefix(ymlProjectData);
        this.functionRegexps[projectKey] = buildTestFunctionRegex(
            testPrefix, this.getTestCaseMacroAliases(), this.getTestRangeMacroAliases()
        );
    }

    private setBuildDirectory(projectKey: string, ymlProjectData: any = undefined) {
        let buildDirectory = 'build';
        if (ymlProjectData) {
            try {
                const ymlProjectBuildDirectory = ymlProjectData[':project'][':build_root'];
                if (ymlProjectBuildDirectory != undefined) {
                    buildDirectory = ymlProjectBuildDirectory;
                }
            } catch (e) {
                this.logger.debug(`setBuildDirectory(${projectKey}): no ':project'/':build_root' in project.yml, using default '${buildDirectory}': ${e}`);
            }
        }
        this.buildDirectories[projectKey] = buildDirectory;
    }

    private setXmlReportPath(projectKey: string, ymlProjectData: any = undefined) {
        let reportFilename = 'cppunit_tests_report.xml';
        if (ymlProjectData) {
            try {
                const ymlProjectReportFilename = ymlProjectData[':report_tests_log_factory'][':cppunit'][':filename'];
                if (ymlProjectReportFilename != undefined) {
                    reportFilename = ymlProjectReportFilename;
                }
            } catch (e) {
                this.logger.debug(`setXmlReportPath(${projectKey}): no ':report_tests_log_factory'/':cppunit'/':filename' in project.yml, using default '${reportFilename}': ${e}`);
            }
        }
        this.reportFilenames[projectKey] = reportFilename;
    }

    private getTestFunctionRegex(projectKey: string): RegExp {
        if (!this.functionRegexps[projectKey]) {
            this.setFunctionRegex(projectKey);
        }
        return this.functionRegexps[projectKey] as RegExp;
    }

    private setFileLabelRegex(projectKey: string, ymlProjectData: any = undefined) {
        let filePrefix = 'test_';
        if (ymlProjectData) {
            try {
                const ymlProjectTestPrefix = ymlProjectData[':project'][':test_file_prefix'];
                if (ymlProjectTestPrefix != undefined) {
                    filePrefix = ymlProjectTestPrefix;
                }
            } catch (e) {
                this.logger.debug(`setFileLabelRegex(${projectKey}): no ':project'/':test_file_prefix' in project.yml, using default '${filePrefix}': ${e}`);
            }
        }
        this.fileLabelRegexps[projectKey] = buildFileLabelRegex(filePrefix);
    }

    private getFileLabelRegex(projectKey: string): RegExp {
        if (!this.fileLabelRegexps[projectKey]) {
            this.setFileLabelRegex(projectKey);
        }
        return this.fileLabelRegexps[projectKey] as RegExp;
    }

    private setTestLabelRegex(projectKey: string, ymlProjectData: any = undefined) {
        const testPrefix = this.getTestPrefix(ymlProjectData);
        this.testLabelRegexps[projectKey] = buildTestLabelRegex(testPrefix);
    }

    private getTestLabelRegex(projectKey: string): RegExp {
        if (!this.testLabelRegexps[projectKey]) {
            this.setTestLabelRegex(projectKey);
        }
        return this.testLabelRegexps[projectKey] as RegExp;
    }

    private setTestLabel(projectKey: string, testName: string): string {
        let testLabel = testName;
        if (this.isPrettyTestLabelEnable) {
            const labelFunctionRegex = this.getTestLabelRegex(projectKey);
            let testLabelMatches = labelFunctionRegex.exec(testName);
            if (testLabelMatches != null) {
                testLabel = testLabelMatches[1];
            }
        }
        return testLabel;
    }

    private setFileLabel(projectKey: string, fileName: string): string {
        let fileLabel = fileName;
        if (this.isPrettyTestFileLabelEnable) {
            const labelFileRegex = this.getFileLabelRegex(projectKey);
            let labelMatches = labelFileRegex.exec(fileName);
            if (labelMatches != null) {
                fileLabel = labelMatches[1];
            }
        }
        return fileLabel;
    }

    // Return a list of parameters from a given TEST_CASE/TEST_RANGE token string. An empty
    // array if the test isn't parametrized.
    private parseParametrizedTestCases(testCases: string): Array<{ args: string, line: number }> {
        const result = expandParametrizedTestCases(testCases, this.getTestCaseMacroAliases(), this.getTestRangeMacroAliases());
        this.logger.trace(`parseParametrizedTestCases: parsed ${result.length} case(s) from '${testCases}'`);
        return result;
    }

    private * getTestFileNodes(projectKey: string, files: string[]): Iterable<CeedlingFileNode> {
        for (const file of files) {
            const projectPath = this.projectData[projectKey].absPath;
            const absPath = path.resolve(projectPath, file);
            const fileLabel = this.setFileLabel(projectKey, file);
            const functions: CeedlingTestFunction[] = [];
            const testRegex = this.getTestFunctionRegex(projectKey);
            let fileText: string;
            try {
                fileText = fs.readFileSync(absPath, 'utf8');
            } catch (e) {
                this.logger.warn(`getTestFileNodes: failed to read '${absPath}', skipping this file: ${e}`);
                continue;
            }
            let match = testRegex.exec(fileText);
            while (match != null) {
                const testCases = this.parseParametrizedTestCases(match[1]);
                const testName = normalizeMultilineFunctionName(match[2]);
                const testLabel = this.setTestLabel(projectKey, testName);
                let line = fileText.substr(0, match.index).split('\n').length - 1;
                line = line + match[0].substr(0, match[0].search(/\S/g)).split('\n').length - 1;
                functions.push({
                    id: `${file}::${testName}`,
                    label: testLabel,
                    line,
                    cases: testCases.map((testCase) => ({
                        id: `${file}::${testName}(${testCase.args})`,
                        label: testCase.args,
                        line: line + testCase.line,
                    })),
                });
                match = testRegex.exec(fileText);
            }
            yield { id: file, label: fileLabel, absPath, projectKey, functions };
        }
    }

    private getYmlProjectPath(projectKey: string): string {
        return path.resolve(
            this.projectData[projectKey].absPath,
            this.projectData[projectKey].ymlFileName
        );
    }

    private getYmlProjectData(projectKey: string): Promise<any | undefined> {
        try {
            if (this.projectData[projectKey].ymlFileName != 'project.yml') {
                return this.mergeYmlProjectData(projectKey);
            }
            return new Promise<any | undefined>((resolve) => {
                const project_yml = this.getYmlProjectPath(projectKey);
                fs.readFile(project_yml, 'utf8', (error, data) => {
                    if (error) {
                        this.logger.error(`Failed to read YAML file '${project_yml}': ${util.format(error)}`);
                        resolve(undefined);
                        return;
                    }
                    try {
                        resolve(yaml.safeLoad(data));
                    } catch (e) {
                        this.logger.error(`Failed to parse YAML file '${project_yml}': ${util.format(e)}`);
                        resolve(undefined);
                    }
                });
            });
        }
        catch (e) {
            this.logger.error(`getYmlProjectData()=${util.format(e)}`);
        }
        return Promise.resolve(undefined);
    }

    private mergeYmlProjectData(projectKey: string): Promise<any | undefined> {
        return new Promise<any | undefined>((resolve) => {
            const project_data = this.getYmlProjectPath(projectKey);
            fs.readFile(project_data, 'utf8', (error, data) => {
                if (error) {
                    this.logger.error(`Failed to read YAML file: ${util.format(error)}`);
                    resolve(undefined);
                    return;
                }
                try {
                    const result = yaml.safeLoad(data);
                    const defaultYmlPath = path.resolve(this.projectData[projectKey].absPath, 'project.yml');
                    fs.readFile(defaultYmlPath, 'utf8', (error, data) => {
                        if (error) {
                            this.logger.error(`Failed to read default YAML file: ${util.format(error)}`);
                            resolve(result);
                            return;
                        }
                        try {
                            const defaultResult = yaml.safeLoad(data) || {};
                            const mergedResult = deepmerge(defaultResult as object, (result as object) || {});
                            resolve(mergedResult);
                        } catch (e) {
                            this.logger.error(`Failed to parse default YAML file: ${util.format(e)}`);
                            resolve(result);
                        }
                    });
                } catch (e) {
                    this.logger.error(`Failed to parse YAML file: ${util.format(e)}`);
                    resolve(undefined);
                }
            });
        });
    }

    private getXmlReportPath(projectKey: string): string {
        // Return the latest updated file between artifacts/test/report.xml and artifacts/gcov/report.xml
        // The report is generated in one of these directories based on the command used: ceedling test:* or gcov:*
        const paths: Array<[string, Date]> = ['test', 'gcov']
            .map((x) => path.resolve(
                this.projectData[projectKey].absPath,
                this.buildDirectories[projectKey], 'artifacts', x, this.reportFilenames[projectKey]
            ))
            .map((x) => [x, fs.existsSync(x) ? fs.statSync(x).mtime : new Date(0)]);
        paths.sort((lhs, rhs) => (rhs[1].getTime() - lhs[1].getTime()));
        this.logger.debug(`getXmlReportPath()=${paths}`);
        return paths[0][0];
    }

    private deleteXmlReport(projectKey: string): Promise<void> {
        return new Promise<void>((resolve) => {
            const xmlReportPath = this.getXmlReportPath(projectKey);
            if (fs.existsSync(xmlReportPath)) {
                fs.unlink(xmlReportPath, (error) => {
                    if (error) {
                        this.logger.error(`Failed to delete XML report: ${util.format(error)}`);
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private getXmlReportData(projectKey: string): Promise<any | undefined> {
        const parser = new xml2js.Parser({ explicitArray: false });
        return new Promise<any | undefined>((resolve) => {
            fs.readFile(this.getXmlReportPath(projectKey), 'utf8', (error, data) => {
                if (error) {
                    this.logger.error(`Failed to read XML report: ${util.format(error)}`);
                    resolve(undefined);
                    return;
                }
                parser.parseString(data, (error: any, result: any) => {
                    if (error) {
                        this.logger.error(`Failed to parse XML report: ${util.format(error)}`);
                        resolve(undefined);
                        return;
                    }
                    resolve(result);
                });
            });
        });
    }

    private getTestListDataFromXmlReport(xmlReportData: any, testType: string) {
        try {
            return getTestListFromXmlReport(xmlReportData, testType);
        } catch (e) {
            this.logger.error(`getTestListDataFromXmlReport(${testType}): unexpected XML report shape: ${e}`);
            return [];
        }
    }
}
