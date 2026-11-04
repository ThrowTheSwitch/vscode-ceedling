// Turns VS Code settings into the Ceedling projects to load, and a project's resolved Ceedling
// configuration into the few values this extension reads from it, with the errors that stop a
// load. It has no `vscode` or filesystem dependency. Callers supply the settings, the platform,
// and a directory check.

import type { ProjectCeedling } from './ceedlingVersions';
import { type CoverageStates, coverageStates } from './coveragePlugins';
import { field, list, stringList, stringSetting } from './parsedXml';
import { pathsFor } from './platformPaths';
import type { CeedlingFileNode } from './testModel';

// Discovery cannot proceed: an unusable Ceedling, configuration, or project path. A workspace
// folder with no Ceedling project in it is not an error.
export class CeedlingLoadError extends Error {
    override name = 'CeedlingLoadError';
}

// What a failed discovery notifies and logs. A load error's message says it all. Anything else is
// unexpected, so its notice gives the message and the log keeps the stack for a bug report.
export function loadFailureMessage(error: unknown): { notice: string, log: string } {
    if (error instanceof CeedlingLoadError) {
        return { notice: error.message, log: error.message };
    }
    const lead = 'Failed to load Ceedling project:';
    return error instanceof Error
        ? { notice: `${lead} ${error.message}`, log: `${lead} ${error.stack ?? error.message}` }
        : { notice: `${lead} ${String(error)}`, log: `${lead} ${String(error)}` };
}

// The launch configuration that debugs a project whose settings name none.
const DEFAULT_DEBUG_LAUNCH_CONFIG = 'ceedling';

// One `ceedlingExplorer.projects` entry, as the user wrote it.
export type ProjectSetting = {
    path: string,
    // Absent means the launch configuration named `ceedling`, as for a folder without entries.
    debugLaunchConfig?: string,
    name?: string,
    // Absent means "use ceedlingExplorer.mixins". An explicit [] opts out of that list.
    mixins?: string[],
};

export type CeedlingProject = {
    // Unique per workspace folder. It labels the project and scopes its tests' ids.
    key: string,
    absPath: string,
    // The base project file within absPath, passed to --project: project.yml, or ceedling.yml
    // when only that exists (Ceedling 1.2.0 and later load either).
    projectFileName: string,
    // The configured project file. When it differs from projectFileName, it applies as a mixin.
    ymlFileName: string,
    // Both default project files exist. Ceedling 1.2.0 and later refuse to choose between them.
    ambiguousProjectFile: boolean,
    debugLaunchConfig: string,
    // Lowest to highest priority, already resolved against ceedlingExplorer.mixins.
    mixins: string[],
};

// The values this extension reads from a project's resolved (`ceedling dumpconfig`) configuration.
export type ProjectState = {
    buildRoot: string,
    reportFilename: string,
    // A regex alternation naming test functions, used unescaped as Unity uses it.
    testPrefix: string,
    testFilePrefix: string,
    executableExtension: string,
    useParamTests: boolean,
    reportPluginEnabled: boolean,
    // Each coverage plugin's reports, undefined for one the project doesn't enable.
    coverage: CoverageStates,
    // `:paths` ↳ `:test` as configured, e.g. `+:test/**`, which places each test's build files.
    testPaths: string[],
    // `:project` ↳ `:which_ceedling`: `gem` for the installed Ceedling, else a path to another. Unset,
    // it reads `gem`, and WHICH_CEEDLING or a `vendor/ceedling` then chooses, as every command does.
    // Before 1.2.2 `ceedling version` never reads it. See versionSeesSelection().
    whichCeedling: string,
    // `:environment`, which Ceedling sets for every tool it runs, by upper-cased name.
    environment: Readonly<Record<string, string>>,
};

// A project discovery loaded: the Ceedling it runs, its resolved configuration, and its test files.
// `configuration` fingerprints the files and settings `state` was resolved from.
export type LoadedProject = CeedlingProject & ProjectCeedling & { state: ProjectState, configuration: string, files: CeedlingFileNode[] };

export function isLoaded(project: CeedlingProject): project is LoadedProject {
    return 'state' in project;
}

// Ceedling's own default name for report_tests_log_factory's CppUnit report.
export const DEFAULT_CPPUNIT_REPORT_FILENAME = 'cppunit_tests_report.xml';

export const DEFAULT_PROJECT_FILE = 'project.yml';
export const ALTERNATE_DEFAULT_PROJECT_FILE = 'ceedling.yml';

// Projects in settings order. With none configured, one default project sits at the workspace
// root. A later entry with a duplicate key replaces an earlier one. `exists` decides which
// default project file a directory uses. Every project's filesystem checks run concurrently, and
// their results apply in settings order, so a missing directory is reported deterministically.
export async function projectsFromSettings(
    settings: { projects: readonly ProjectSetting[], mixins: readonly string[] },
    workspacePath: string,
    platform: NodeJS.Platform,
    isDirectory: (absPath: string) => Promise<boolean>,
    exists: (absPath: string) => Promise<boolean>,
): Promise<CeedlingProject[]> {
    checkSettings(settings);
    // Path rules follow the given platform rather than the host's, so Windows paths resolve as
    // Windows paths wherever this runs.
    const paths = pathsFor(platform);
    const root = platform === 'win32' ? withUppercaseDrive(workspacePath) : workspacePath;
    if (settings.projects.length === 0) {
        const absPath = paths.resolve(root);
        return [{ key: 'default', absPath, ...(await projectFiles(absPath, undefined, platform, exists)), debugLaunchConfig: DEFAULT_DEBUG_LAUNCH_CONFIG, mixins: [...settings.mixins] }];
    }
    const checked = await Promise.all(settings.projects.map(async (setting) => {
        const project = await projectFromSetting(setting, settings.mixins, paths.resolve(root), platform, exists);
        return { project, directory: await isDirectory(project.absPath) };
    }));
    const projects = new Map<string, CeedlingProject>();
    for (const { project, directory } of checked) {
        if (!directory) {
            throw new CeedlingLoadError(`The project path ${project.absPath} does not exist or is not a directory.`);
        }
        projects.set(project.key, project);
    }
    return [...projects.values()];
}

// Settings are user JSON. VS Code's editor follows package.json's schema, but nothing enforces it,
// so a malformed value stops discovery with an error naming it.
function checkSettings(settings: { projects: unknown, mixins: unknown }): void {
    const fail = (setting: string, expected: string): never => { throw new CeedlingLoadError(`ceedlingExplorer.${setting} must be ${expected}.`); };
    const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (!strings(settings.mixins)) fail('mixins', 'a list of strings');
    if (!Array.isArray(settings.projects)) fail('projects', 'a list');
    // Only debugging needs a launch configuration, and an entry without mixins takes the global ones.
    (settings.projects as unknown[]).forEach((project, i) => {
        const given = (name: string) => field(project, name) ?? undefined;
        if (typeof field(project, 'path') !== 'string') fail(`projects[${i}].path`, 'a string');
        for (const name of ['debugLaunchConfig', 'name']) {
            if (given(name) !== undefined && typeof given(name) !== 'string') fail(`projects[${i}].${name}`, 'a string');
        }
        if (given('mixins') !== undefined && !strings(given('mixins'))) fail(`projects[${i}].mixins`, 'a list of strings');
    });
}

// A path Ceedling reads as a YAML file, as a project file or a mixin.
export function isYamlFile(filePath: string): boolean {
    return /\.ya?ml$/i.test(filePath);
}

// A mixin naming a file, rather than one Ceedling finds by name through its load paths.
export function isMixinFile(mixin: string): boolean {
    return /[\\/]/.test(mixin) || isYamlFile(mixin);
}

// Gcov's XML report generation fails on Windows unless the drive letter is uppercase.
function withUppercaseDrive(windowsPath: string): string {
    return windowsPath.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}

// Whether a file name is one of Ceedling's default project files, as the platform's filesystem
// compares names. Windows and macOS fold case, so there Project.yml is project.yml.
function isDefaultProjectFile(fileName: string | undefined, platform: NodeJS.Platform): boolean {
    const folds = platform === 'win32' || platform === 'darwin';
    const same = (a: string) => folds ? a.toLowerCase() === fileName?.toLowerCase() : a === fileName;
    return same(DEFAULT_PROJECT_FILE) || same(ALTERNATE_DEFAULT_PROJECT_FILE);
}

// A YAML path names a project file. Any other path names a directory holding a default
// project file. The key is the configured name, else an alternate file's base name, else the path.
async function projectFromSetting(
    setting: ProjectSetting, globalMixins: readonly string[], root: string, platform: NodeJS.Platform, exists: (absPath: string) => Promise<boolean>,
): Promise<CeedlingProject> {
    const paths = pathsFor(platform);
    let directory = setting.path;
    let configuredFile: string | undefined;
    let key = setting.path;
    if (isYamlFile(setting.path)) {
        const segments = setting.path.split(/[\\/]/);
        configuredFile = segments.pop() ?? setting.path;
        directory = segments.join('/') || '.';
        if (!isDefaultProjectFile(configuredFile, platform)) {
            key = configuredFile.replace(/\.ya?ml$/i, '');
        }
    }
    const resolved = paths.resolve(root, directory);
    const absPath = platform === 'win32' ? withUppercaseDrive(resolved) : resolved;
    return {
        key: setting.name ?? key,
        absPath,
        ...(await projectFiles(absPath, configuredFile, platform, exists)),
        debugLaunchConfig: setting.debugLaunchConfig ?? DEFAULT_DEBUG_LAUNCH_CONFIG,
        mixins: [...(setting.mixins ?? globalMixins)],
    };
}

// The base project file is project.yml unless only ceedling.yml exists. A configured default
// project file is itself the base. Any other configured file applies over the base as a mixin.
async function projectFiles(
    absPath: string, configuredFile: string | undefined, platform: NodeJS.Platform, exists: (absPath: string) => Promise<boolean>,
): Promise<Pick<CeedlingProject, 'projectFileName' | 'ymlFileName' | 'ambiguousProjectFile'>> {
    const paths = pathsFor(platform);
    const [hasDefault, hasAlternate] = await Promise.all([
        exists(paths.join(absPath, DEFAULT_PROJECT_FILE)),
        exists(paths.join(absPath, ALTERNATE_DEFAULT_PROJECT_FILE)),
    ]);
    const projectFileName = configuredFile !== undefined && isDefaultProjectFile(configuredFile, platform) ? configuredFile : (hasAlternate && !hasDefault ? ALTERNATE_DEFAULT_PROJECT_FILE : DEFAULT_PROJECT_FILE);
    return {
        projectFileName,
        ymlFileName: configuredFile ?? projectFileName,
        ambiguousProjectFile: configuredFile === undefined && hasDefault && hasAlternate,
    };
}

export function projectState(resolved: unknown, platform: NodeJS.Platform): ProjectState {
    const enabledPlugins = field(resolved, ':plugins', ':enabled');
    return {
        buildRoot: stringSetting(resolved, 'build', ':project', ':build_root'),
        reportFilename: stringSetting(resolved, DEFAULT_CPPUNIT_REPORT_FILENAME, ':report_tests_log_factory', ':cppunit', ':filename'),
        testPrefix: stringSetting(resolved, 'test|spec|should', ':test_runner', ':test_prefix'),
        testFilePrefix: stringSetting(resolved, 'test_', ':project', ':test_file_prefix'),
        executableExtension: stringSetting(resolved, platform === 'win32' ? '.exe' : '.out', ':extension', ':executable'),
        useParamTests: field(resolved, ':unity', ':use_param_tests') === true,
        reportPluginEnabled: Array.isArray(enabledPlugins) && enabledPlugins.includes('report_tests_log_factory'),
        coverage: coverageStates(resolved),
        testPaths: stringList(field(resolved, ':paths', ':test')),
        whichCeedling: stringSetting(resolved, 'gem', ':project', ':which_ceedling'),
        environment: environmentOf(resolved, platform),
    };
}

// Each `:environment` entry is a one-name mapping. Ceedling joins a list value with the platform's
// path separator, as dumpconfig already shows it, and sets any other value as its text.
function environmentOf(resolved: unknown, platform: NodeJS.Platform): Record<string, string> {
    const environment: Record<string, string> = {};
    const textOf = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
    for (const entry of list(field(resolved, ':environment'))) {
        for (const [name, value] of typeof entry === 'object' && entry !== null ? Object.entries(entry) : []) {
            const text = Array.isArray(value) ? value.map(textOf).filter((part) => part !== undefined).join(pathsFor(platform).delimiter) : textOf(value);
            if (text !== undefined) {
                environment[name.replace(/^:/, '').toUpperCase()] = text;
            }
        }
    }
    return environment;
}
