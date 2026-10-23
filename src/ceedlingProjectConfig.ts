// Turns VS Code settings into the Ceedling projects to load, and a project's resolved Ceedling
// configuration into the few values this extension reads from it. It has no `vscode` or
// filesystem dependency. Callers supply the settings, the platform, and a directory check.

import path from 'path';

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
    // The project file within absPath. Any name but project.yml is applied as a mixin over it.
    ymlFileName: string,
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
};

// Ceedling's own default name for report_tests_log_factory's CppUnit report.
export const DEFAULT_CPPUNIT_REPORT_FILENAME = 'cppunit_tests_report.xml';

const DEFAULT_PROJECT_FILE = 'project.yml';

// Projects in settings order. With none configured, one default project sits at the workspace
// root. A later entry with a duplicate key replaces an earlier one.
export function projectsFromSettings(
    settings: { projects: readonly ProjectSetting[], mixins: readonly string[] },
    workspacePath: string,
    platform: NodeJS.Platform,
    isDirectory: (absPath: string) => boolean,
): CeedlingProject[] {
    // Path rules follow the given platform rather than the host's, so Windows paths resolve as
    // Windows paths wherever this runs. Gcov's XML report generation fails on Windows unless the
    // drive letter is uppercase.
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? workspacePath.charAt(0).toUpperCase() + workspacePath.slice(1) : workspacePath;
    if (settings.projects.length === 0) {
        return [{ key: 'default', absPath: paths.resolve(root), ymlFileName: DEFAULT_PROJECT_FILE, debugLaunchConfig: 'ceedling', mixins: [...settings.mixins] }];
    }
    const projects = new Map<string, CeedlingProject>();
    for (const setting of settings.projects) {
        const project = projectFromSetting(setting, settings.mixins, paths.resolve(root), paths);
        if (!isDirectory(project.absPath)) {
            throw new CeedlingLoadError(`The project path ${project.absPath} does not exist or is not a directory.`);
        }
        projects.set(project.key, project);
    }
    return [...projects.values()];
}

// A path ending in .yml names a project file. Any other path names a directory holding
// project.yml. The key is the configured name, else an alternate file's base name, else the path.
function projectFromSetting(setting: ProjectSetting, globalMixins: readonly string[], root: string, paths: typeof path.posix): CeedlingProject {
    let directory = setting.path;
    let ymlFileName = DEFAULT_PROJECT_FILE;
    let key = setting.path;
    if (setting.path.endsWith('.yml')) {
        const segments = setting.path.split(/[\\/]/);
        ymlFileName = segments.pop()!;
        directory = segments.join('/') || '.';
        if (ymlFileName !== DEFAULT_PROJECT_FILE) {
            key = ymlFileName.slice(0, -'.yml'.length);
        }
    }
    return {
        key: setting.name ?? key,
        absPath: paths.resolve(root, directory),
        ymlFileName,
        debugLaunchConfig: setting.debugLaunchConfig,
        mixins: [...(setting.mixins ?? globalMixins)],
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
    };
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
