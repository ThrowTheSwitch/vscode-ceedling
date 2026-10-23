// Turns VS Code settings into the Ceedling projects to load, and a project's resolved Ceedling
// configuration into the few values this extension reads from it. It has no `vscode` or
// filesystem dependency. Callers supply the settings, the platform, and a directory check.

import path from 'path';
import semver from 'semver';

// Discovery cannot proceed: an unusable Ceedling, configuration, or project path. A workspace
// folder with no Ceedling project in it is not an error.
export class CeedlingLoadError extends Error { }

// One `ceedlingExplorer.projects` entry, as the user wrote it.
export type ProjectSetting = {
    path: string,
    debugLaunchConfig: string,
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
    // undefined when the project doesn't enable Ceedling's gcov plugin.
    coverage: CoverageState | undefined,
};

// What a coverage run leaves to read. Ceedling's gcov plugin writes a Cobertura report through
// gcovr, ReportGenerator, or both, into fixed directories under the build root.
export type CoverageState = {
    // Coverage runs leave reports only through the `report:gcov` task.
    reportTask: boolean,
    // Where a Cobertura report may appear, relative to the build root, most preferred first.
    // gcovr's leads. ReportGenerator nests its own in a subdirectory when it writes several report
    // types. Empty when neither utility writes one.
    coberturaReports: string[],
};

// Ceedling's own default name for report_tests_log_factory's CppUnit report.
export const DEFAULT_CPPUNIT_REPORT_FILENAME = 'cppunit_tests_report.xml';

export const DEFAULT_PROJECT_FILE = 'project.yml';
export const ALTERNATE_DEFAULT_PROJECT_FILE = 'ceedling.yml';

// Ceedling features this extension uses only where they exist.
export type CeedlingCapabilities = {
    // `dumpconfig --stdout` writes the resolved configuration to stdout instead of a file.
    dumpconfigStdout: boolean,
    // Delta builds reuse cached results unless `--force-test-rerun` is given. Their cache
    // ignores --test-case, so a filtered run can report another run's results without it.
    forceTestRerun: boolean,
    // A `test:` task accepts a project-relative path, which tells same-named test files apart.
    pathQualifiedTestTasks: boolean,
    // A `gcov:` task does too. Ceedling 1.2.0's gcov plugin still took a bare name.
    pathQualifiedCoverageTasks: boolean,
    // ceedling.yml is a default project file, like project.yml.
    ceedlingYml: boolean,
};

// The features of a reported Ceedling version. A build suffix such as `1.2.0-13a540f` counts as
// its release, though semver would rank it below.
export function capabilitiesOf(version: string): CeedlingCapabilities {
    const release = semver.coerce(version);
    const atLeast = (minimum: string) => release !== null && semver.gte(release, minimum);
    return {
        dumpconfigStdout: atLeast('1.2.0'),
        forceTestRerun: atLeast('1.2.0'),
        pathQualifiedTestTasks: atLeast('1.2.0'),
        pathQualifiedCoverageTasks: atLeast('1.2.1'),
        ceedlingYml: atLeast('1.2.0'),
    };
}

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
    // Path rules follow the given platform rather than the host's, so Windows paths resolve as
    // Windows paths wherever this runs.
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? withUppercaseDrive(workspacePath) : workspacePath;
    if (settings.projects.length === 0) {
        const absPath = paths.resolve(root);
        return [{ key: 'default', absPath, ...(await projectFiles(absPath, undefined, paths, exists)), debugLaunchConfig: 'ceedling', mixins: [...settings.mixins] }];
    }
    const checked = await Promise.all(settings.projects.map(async (setting) => {
        const project = await projectFromSetting(setting, settings.mixins, paths.resolve(root), paths, exists);
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

// Gcov's XML report generation fails on Windows unless the drive letter is uppercase.
function withUppercaseDrive(windowsPath: string): string {
    return windowsPath.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase());
}

// One key per file or directory, for comparing paths and for grouping and locking work by
// project directory. Windows paths are case-insensitive, so every spelling of one shares a key.
export function pathKey(absPath: string, platform: NodeJS.Platform): string {
    return platform === 'win32' ? absPath.toLowerCase() : absPath;
}

// A path ending in .yml names a project file. Any other path names a directory holding a default
// project file. The key is the configured name, else an alternate file's base name, else the path.
async function projectFromSetting(
    setting: ProjectSetting, globalMixins: readonly string[], root: string, paths: typeof path.posix, exists: (absPath: string) => Promise<boolean>,
): Promise<CeedlingProject> {
    let directory = setting.path;
    let configuredFile: string | undefined;
    let key = setting.path;
    if (setting.path.endsWith('.yml')) {
        const segments = setting.path.split(/[\\/]/);
        configuredFile = segments.pop() ?? setting.path;
        directory = segments.join('/') || '.';
        if (configuredFile !== DEFAULT_PROJECT_FILE && configuredFile !== ALTERNATE_DEFAULT_PROJECT_FILE) {
            key = configuredFile.slice(0, -'.yml'.length);
        }
    }
    const resolved = paths.resolve(root, directory);
    const absPath = paths === path.win32 ? withUppercaseDrive(resolved) : resolved;
    return {
        key: setting.name ?? key,
        absPath,
        ...(await projectFiles(absPath, configuredFile, paths, exists)),
        debugLaunchConfig: setting.debugLaunchConfig,
        mixins: [...(setting.mixins ?? globalMixins)],
    };
}

// The base project file is project.yml unless only ceedling.yml exists. A configured default
// project file is itself the base. Any other configured file applies over the base as a mixin.
async function projectFiles(
    absPath: string, configuredFile: string | undefined, paths: typeof path.posix, exists: (absPath: string) => Promise<boolean>,
): Promise<Pick<CeedlingProject, 'projectFileName' | 'ymlFileName' | 'ambiguousProjectFile'>> {
    const [hasDefault, hasAlternate] = await Promise.all([
        exists(paths.join(absPath, DEFAULT_PROJECT_FILE)),
        exists(paths.join(absPath, ALTERNATE_DEFAULT_PROJECT_FILE)),
    ]);
    const isDefaultName = configuredFile === DEFAULT_PROJECT_FILE || configuredFile === ALTERNATE_DEFAULT_PROJECT_FILE;
    const projectFileName = isDefaultName ? configuredFile : (hasAlternate && !hasDefault ? ALTERNATE_DEFAULT_PROJECT_FILE : DEFAULT_PROJECT_FILE);
    return {
        projectFileName,
        ymlFileName: configuredFile ?? projectFileName,
        ambiguousProjectFile: configuredFile === undefined && hasDefault && hasAlternate,
    };
}

export function projectState(resolved: unknown, platform: NodeJS.Platform): ProjectState {
    const enabledPlugins = setting(resolved, ':plugins', ':enabled');
    return {
        buildRoot: stringSetting(resolved, 'build', ':project', ':build_root'),
        reportFilename: stringSetting(resolved, DEFAULT_CPPUNIT_REPORT_FILENAME, ':report_tests_log_factory', ':cppunit', ':filename'),
        testPrefix: stringSetting(resolved, 'test|spec|should', ':test_runner', ':test_prefix'),
        testFilePrefix: stringSetting(resolved, 'test_', ':project', ':test_file_prefix'),
        executableExtension: stringSetting(resolved, platform === 'win32' ? '.exe' : '.out', ':extension', ':executable'),
        useParamTests: setting(resolved, ':unity', ':use_param_tests') === true,
        reportPluginEnabled: Array.isArray(enabledPlugins) && enabledPlugins.includes('report_tests_log_factory'),
        coverage: coverageState(resolved),
    };
}

// Where a gcov project's Cobertura reports appear, and whether they wait for report:gcov. undefined
// without the gcov plugin. Ceedling compares utility and report names case-insensitively, and with
// no :utilities: listed the plugin uses gcovr.
export function coverageState(resolved: unknown): CoverageState | undefined {
    const enabledPlugins = setting(resolved, ':plugins', ':enabled');
    if (!Array.isArray(enabledPlugins) || !enabledPlugins.includes('gcov')) {
        return undefined;
    }
    const names = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : [];
    const listed = names(setting(resolved, ':gcov', ':utilities'));
    const utilities = listed.length > 0 ? listed : ['gcovr'];
    const cobertura = names(setting(resolved, ':gcov', ':reports')).includes('cobertura');
    const coberturaReports = !cobertura ? [] : [
        ...utilities.includes('gcovr') ? [`artifacts/gcov/gcovr/${stringSetting(resolved, 'GcovCoverageCobertura.xml', ':gcov', ':gcovr', ':cobertura_artifact_filename')}`] : [],
        ...utilities.includes('reportgenerator') ? ['artifacts/gcov/ReportGenerator/Cobertura.xml', 'artifacts/gcov/ReportGenerator/Cobertura/Cobertura.xml'] : [],
    ];
    return { reportTask: setting(resolved, ':gcov', ':report_task') === true, coberturaReports };
}

// What a project must configure before a coverage run can show anything, or undefined.
export function coverageProblem(projectKey: string, coverage: CoverageState): string | undefined {
    return coverage.coberturaReports.length > 0 ? undefined :
        `Ceedling project '${projectKey}' writes no Cobertura coverage report, so Run with Coverage has nothing to show. ` +
        `Add Cobertura to :gcov: ↳ :reports:, with gcovr or ReportGenerator among :gcov: ↳ :utilities:. ` +
        `See "Code coverage" in this extension's README.`;
}

// The value at a path of YAML symbol keys, or undefined anywhere along a missing path.
function setting(config: unknown, ...keys: string[]): unknown {
    let value = config;
    for (const key of keys) {
        if (typeof value !== 'object' || value === null) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

function stringSetting(config: unknown, fallback: string, ...keys: string[]): string {
    const value = setting(config, ...keys);
    return typeof value === 'string' ? value : fallback;
}
