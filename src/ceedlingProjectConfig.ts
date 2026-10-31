// Turns VS Code settings into the Ceedling projects to load, and a project's resolved Ceedling
// configuration into the few values this extension reads from it. It has no `vscode` or
// filesystem dependency. Callers supply the settings, the platform, and a directory check.

import path from 'path';
import semver from 'semver';
import type { ReportedCeedling } from './ceedlingOutputParsing';

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
    // `:paths` ↳ `:test` as configured, e.g. `+:test/**`, which places each test's build files.
    testPaths: string[],
    // `:project` ↳ `:which_ceedling`: `gem` for the installed Ceedling, else a path to another. Unset,
    // it reads `gem`, and WHICH_CEEDLING or a `vendor/ceedling` then chooses, as every command does.
    // Before 1.2.2 `ceedling version` never reads it. See versionSeesSelection().
    whichCeedling: string,
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

// The oldest Ceedling this extension runs.
export const MINIMUM_CEEDLING_VERSION = '1.0.0';

// The first Ceedling release with each feature this extension uses only where it exists. Every
// feature gate reads one of two tables. These are the application's, the installation that runs
// the project, read through capabilitiesOf(). LAUNCHER_FEATURES are the `ceedling` command's.
const APPLICATION_FEATURES = {
    // `dumpconfig --stdout` writes the resolved configuration to stdout instead of a file.
    dumpconfigStdout: '1.2.0',
    // Delta builds reuse cached results unless `--force-test-rerun` is given. Before 1.2.1 their
    // cache ignores --test-case. In every version it ignores deleted coverage counters.
    forceTestRerun: '1.2.0',
    // A `test:` task accepts a project-relative path, which tells same-named test files apart.
    pathQualifiedTestTasks: '1.2.0',
    // A `gcov:` task does too. Ceedling 1.2.0's gcov plugin still took a bare name.
    pathQualifiedCoverageTasks: '1.2.1',
    // ceedling.yml is a default project file, like project.yml.
    ceedlingYml: '1.2.0',
    // Same-named test files build apart, each in directories of its own. See testBuildLayout().
    nestedTestBuilds: '1.2.0',
    // A test's build files sit under its path from the project root instead, e.g.
    // `test/out/test/unit/test_foo/`. See testBuildName().
    projectPathTestNames: '1.2.2',
    // `dumpconfig` and `files:test` write no files. Earlier versions rewrite the build root's
    // vendored Unity and CMock sources in place (Ceedling#1361). Both still create the build root's
    // missing directories, as every command does.
    readOnlyDiscovery: '1.2.1',
} as const;

// The features of the `ceedling` command itself, which may hand a project off to another
// installation, read through launcherCapabilitiesOf().
const LAUNCHER_FEATURES = {
    // Handing off to another installation, `ceedling version` reports that installation's own
    // version. Earlier launchers report their own release, with the other one's commit (Ceedling#1365).
    reportsApplicationVersion: '1.2.2',
    // `ceedling version` reads the project file and takes --project and --mixin, so it reports the
    // installation `:project` ↳ `:which_ceedling` selects in the project file or a mixin. Earlier
    // launchers reject both options.
    versionReadsProject: '1.2.2',
} as const;

export type CeedlingFeature = keyof typeof APPLICATION_FEATURES;
export type LauncherFeature = keyof typeof LAUNCHER_FEATURES;

export type CeedlingCapabilities = Readonly<Record<CeedlingFeature, boolean>>;
export type LauncherCapabilities = Readonly<Record<LauncherFeature, boolean>>;

// The release a reported version counts as, e.g. `1.2.0` for a build's `1.2.0-13a540f`, which
// semver would rank below 1.2.0. undefined when the text names no version.
export function ceedlingRelease(reported: string): string | undefined {
    return semver.coerce(reported)?.version;
}

export function isSupportedRelease(release: string): boolean {
    return semver.gte(release, MINIMUM_CEEDLING_VERSION);
}

export function firstRelease(feature: CeedlingFeature | LauncherFeature): string {
    return { ...APPLICATION_FEATURES, ...LAUNCHER_FEATURES }[feature];
}

// The release of the Ceedling that runs a project, and whether `ceedling version` shows it exactly.
// A launcher before 1.2.2 reports its own release as the application's, with the application's
// commit. Only a commit matching the launcher's shows the application's release. Otherwise the
// launcher's release stands in for it. undefined when either version names no release.
export function applicationRelease(reported: ReportedCeedling): { release: string, exactRelease: boolean } | undefined {
    const release = ceedlingRelease(reported.application);
    const launcher = reported.launcher ?? reported.application;
    if (release === undefined || ceedlingRelease(launcher) === undefined) {
        return undefined;
    }
    // A `-<commit>` suffix comes only from an installation with a GIT_COMMIT_SHA file.
    const sameBuild = launcher === reported.application && /-[0-9a-f]+$/i.test(launcher);
    return { release, exactRelease: reported.launcher === undefined || sameBuild || launcherCapabilitiesOf(launcher).reportsApplicationVersion };
}

// Each feature of a table, and whether a reported version has it as of its release.
function featuresOf<Feature extends string>(table: Readonly<Record<Feature, string>>, version: string): Readonly<Record<Feature, boolean>> {
    const release = ceedlingRelease(version);
    return Object.fromEntries(Object.entries<string>(table).map(([feature, first]) => [feature, release !== undefined && semver.gte(release, first)])) as Record<Feature, boolean>;
}

// The features of the application a project runs, as of its reported release.
export function capabilitiesOf(version: string): CeedlingCapabilities {
    return featuresOf(APPLICATION_FEATURES, version);
}

// The features of the launcher, the `ceedling` command, as of its reported release.
export function launcherCapabilitiesOf(version: string): LauncherCapabilities {
    return featuresOf(LAUNCHER_FEATURES, version);
}

// Where a release builds each test: under its base name, under its directory within its test
// path from 1.2.0, or under its path from the project root from 1.2.2. Newest first.
export const TEST_BUILD_LAYOUTS = ['projectPath', 'testRoot', 'flat'] as const;
export type TestBuildLayout = typeof TEST_BUILD_LAYOUTS[number];

export function testBuildLayout(capabilities: CeedlingCapabilities): TestBuildLayout {
    return capabilities.projectPathTestNames ? 'projectPath' : capabilities.nestedTestBuilds ? 'testRoot' : 'flat';
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
    checkSettings(settings);
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

// Settings are user JSON. VS Code's editor follows package.json's schema, but nothing enforces it,
// so a malformed value stops discovery with an error naming it.
function checkSettings(settings: { projects: unknown, mixins: unknown }): void {
    const fail = (setting: string, expected: string): never => { throw new CeedlingLoadError(`ceedlingExplorer.${setting} must be ${expected}.`); };
    const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (!strings(settings.mixins)) fail('mixins', 'a list of strings');
    if (!Array.isArray(settings.projects)) fail('projects', 'a list');
    (settings.projects as unknown[]).forEach((project, i) => {
        const field = (name: string) => typeof project === 'object' && project !== null ? (project as Record<string, unknown>)[name] : undefined;
        if (typeof field('path') !== 'string') fail(`projects[${i}].path`, 'a string');
        if (typeof field('debugLaunchConfig') !== 'string') fail(`projects[${i}].debugLaunchConfig`, 'a string');
        if (field('name') !== undefined && typeof field('name') !== 'string') fail(`projects[${i}].name`, 'a string');
        if (field('mixins') !== undefined && !strings(field('mixins'))) fail(`projects[${i}].mixins`, 'a list of strings');
    });
}

// A path Ceedling reads as a YAML file, as a project file or a mixin.
export function isYamlFile(filePath: string): boolean {
    return /\.ya?ml$/i.test(filePath);
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

// A YAML path names a project file. Any other path names a directory holding a default
// project file. The key is the configured name, else an alternate file's base name, else the path.
async function projectFromSetting(
    setting: ProjectSetting, globalMixins: readonly string[], root: string, paths: typeof path.posix, exists: (absPath: string) => Promise<boolean>,
): Promise<CeedlingProject> {
    let directory = setting.path;
    let configuredFile: string | undefined;
    let key = setting.path;
    if (isYamlFile(setting.path)) {
        const segments = setting.path.split(/[\\/]/);
        configuredFile = segments.pop() ?? setting.path;
        directory = segments.join('/') || '.';
        if (configuredFile !== DEFAULT_PROJECT_FILE && configuredFile !== ALTERNATE_DEFAULT_PROJECT_FILE) {
            key = configuredFile.replace(/\.ya?ml$/i, '');
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

// Whether `ceedling version`, run in the project directory, reports the Ceedling that `:project` ↳
// `:which_ceedling` selects without reading it, as every version before 1.2.2 does. It picks the
// installed gem, or a `vendor/ceedling` it finds there, as `ceedling new --local` vendors and names.
// WHICH_CEEDLING outranks both alike. Ceedling reads `gem` in any case, around any spaces.
export function versionSeesSelection(whichCeedling: string, projectDir: string, platform: NodeJS.Platform): boolean {
    const which = whichCeedling.trim();
    if (which.toLowerCase() === 'gem') {
        return true;
    }
    const paths = platform === 'win32' ? path.win32 : path.posix;
    return pathKey(paths.resolve(projectDir, which), platform) === pathKey(paths.resolve(projectDir, 'vendor', 'ceedling'), platform);
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
        testPaths: stringList(setting(resolved, ':paths', ':test')),
        whichCeedling: stringSetting(resolved, 'gem', ':project', ':which_ceedling'),
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
    const names = (value: unknown) => stringList(value).map((name) => name.toLowerCase());
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

// The strings of a list setting. Anything else in the list, or a setting that isn't one, is ignored.
function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringSetting(config: unknown, fallback: string, ...keys: string[]): string {
    const value = setting(config, ...keys);
    return typeof value === 'string' ? value : fallback;
}

// The name Ceedling gives a test's build directories, e.g. under test/out and gcov/out.
// - flat, before 1.2.0: the test file's base name.
// - testRoot, 1.2.0 and 1.2.1: the file's directory within the longest test path holding it comes first,
//   as Ceedling's PathMirror.relative_subdir places it. `unit/test_foo` for `test/unit/test_foo.c`
//   under `+:test/**`. Ceedling compares paths as written, with `/`.
// - projectPath, from 1.2.2: the file's path from the project root, as projectPathBuildName() spells it.
export function testBuildName(testId: string, layout: TestBuildLayout, project: { testPaths: readonly string[], projectDir: string, platform: NodeJS.Platform }): string {
    if (layout === 'projectPath') {
        return projectPathBuildName(testId, project.projectDir, project.platform);
    }
    const id = testId.replace(/\\/g, '/');
    const name = id.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
    const directory = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.';
    const roots = project.testPaths.map((testPath) => testPathRoot(testPath.replace(/\\/g, '/'))).filter((root) => root !== '');
    const [root] = roots.filter((r) => directory === r || directory.startsWith(`${r}/`)).sort((a, b) => b.length - a.length);
    return layout === 'testRoot' && root !== undefined && directory !== root ? `${directory.slice(root.length + 1)}/${name}` : name;
}

// The file name of a test's executable, in its build directory: the test file's base name with
// `extension` in place of its own, as Ceedling's form_test_executable_filepath gives it. Ruby's
// File.extname leaves a dotfile's name whole. A marker-named file keeps its name, which only its
// build directory escapes.
export function testExecutableName(testId: string, extension: string): string {
    return `${testId.replace(/\\/g, '/').replace(/^.*\//, '').replace(/(?<=.)\.[^.]*$/, '')}${extension}`;
}

// A segment Ceedling would read as one of its markers, in any case, perhaps already escaped.
const MARKER_NAMED = /^_+(?:up|abs|unc|ceedling)_$/i;

// A test's path from the project root, without its extension, as Ceedling 1.2.2's
// BuildSubpath.encode spells it. The path is normalized, and each `..` becomes `_up_`. A path on
// another Windows drive goes under `_abs_/<DRIVE>`, and one on a share under `_unc_`. A segment
// named like a marker gains a leading `_`, so no real folder reads as one.
function projectPathBuildName(testId: string, projectDir: string, platform: NodeJS.Platform): string {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    // Ruby's File.extname leaves a dotfile's name whole.
    const withoutExtension = testId.replace(/\\/g, '/').replace(/(?<=[^/])\.[^./]*$/, '');
    const relative = paths.relative(projectDir, paths.resolve(projectDir, withoutExtension));
    const segments = (text: string) => text.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
    const escape = (segment: string) => MARKER_NAMED.test(segment) ? `_${segment}` : segment;
    if (relative.startsWith('\\\\')) {
        return ['_unc_', ...segments(relative).map(escape)].join('/');
    }
    if (paths.isAbsolute(relative)) {
        const [drive, ...rest] = segments(relative);
        return ['_abs_', (drive ?? '').replace(/:$/, '').toUpperCase(), ...rest.map(escape)].join('/');
    }
    return segments(relative).map((segment) => segment === '..' ? '_up_' : escape(segment)).join('/');
}

// A test path without its `+:` or `-:` decorator, cut back to the directory before its first glob,
// as Ceedling's FilePathUtils.no_decorators does. Empty when a glob leads it.
function testPathRoot(testPath: string): string {
    const bare = testPath.trim().replace(/^[+-]:/, '').trim();
    const glob = bare.search(/[*?{}]/);
    if (glob < 0) {
        return bare.replace(/\/$/, '');
    }
    const separator = bare.lastIndexOf('/', glob - 1);
    return separator < 0 ? '' : separator === 0 ? '/' : bare.slice(0, separator);
}
