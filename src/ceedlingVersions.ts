// What each Ceedling release can do, as far as this extension asks: two tables of the first
// release with each feature, the application's and the launcher's, and what a version report says
// about the Ceedling a project runs. Every feature gate reads them. It has no `vscode` dependency.
import semver from 'semver';
import util from 'util';
import { exceptionOf, parseCeedlingVersions, type ReportedCeedling, withException } from './ceedlingOutputParsing';
import type { CeedlingResult } from './ceedlingProcess';
import type { Log } from './log';
import { samePath } from './platformPaths';

// Where a project keeps a Ceedling of its own, which runs in place of the installed one, as
// `ceedling new --local` vendors it.
export const VENDORED_CEEDLING = 'vendor/ceedling';

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

// Whether `ceedling version`, run in the project directory, reports the Ceedling that `:project` ↳
// `:which_ceedling` selects without reading it, as every version before 1.2.2 does. It picks the
// installed gem, or a `vendor/ceedling` it finds there, as `ceedling new --local` vendors and names.
// WHICH_CEEDLING outranks both alike. Ceedling reads `gem` in any case, around any spaces.
export function versionSeesSelection(whichCeedling: string, projectDir: string, platform: NodeJS.Platform): boolean {
    const which = whichCeedling.trim();
    if (which.toLowerCase() === 'gem') {
        return true;
    }
    return samePath(which, VENDORED_CEEDLING, platform, projectDir);
}

// The Ceedling that runs a project, as `ceedling version` reports it. `release` counts a build as
// its release, e.g. 1.2.0 for 1.2.0-13a540f. `exactRelease` is false when the report can't show
// the release, and the launcher's stands in. See applicationRelease().
// `launcher` holds the features of the `ceedling` command that checked it.
export type ProjectCeedling = { release: string, exactRelease: boolean, capabilities: CeedlingCapabilities, launcher: LauncherCapabilities };

// What a project's version check found. A `configuration` problem is the project's own, e.g. a
// missing mixin or a :which_ceedling: path that doesn't exist, and leaves other projects loading.
// An `unusable` Ceedling stops discovery. A `warning` says the release is a guess.
export type VersionCheck =
    | { kind: 'checked', ceedling: ProjectCeedling, warning: string | undefined }
    | { kind: 'configuration', message: string }
    | { kind: 'unusable', message: string };

// Finds the release of the Ceedling the project runs, whether the report shows it exactly, and the
// launcher's features. `runVersion` runs `ceedling version` in the project directory, which finds
// a Ceedling vendored in `vendor/ceedling`, and WHICH_CEEDLING applies anywhere. From 1.2.2
// `ceedling version` also reads the project's configuration, so the project checks again with its
// own arguments (`withProject`), as its other commands run. A bare check reads whichever default
// project file Ceedling prefers, or CEEDLING_PROJECT_FILE. Older launchers reject the arguments.
export async function checkVersion(
    projectKey: string, runVersion: (withProject: boolean) => Promise<CeedlingResult>, log: Pick<Log, 'debug'>,
): Promise<VersionCheck> {
    const bare = await versionReport(projectKey, false, runVersion, log);
    if (bare.kind !== 'reported') {
        return bare;
    }
    const launcher = launcherCapabilitiesOf(bare.reported.launcher ?? bare.reported.application);
    const report = launcher.versionReadsProject ? await versionReport(projectKey, true, runVersion, log) : bare;
    if (report.kind !== 'reported') {
        return report;
    }
    const { reported, release } = report;
    if (!isSupportedRelease(release.release)) {
        return {
            kind: 'unusable',
            message: `Ceedling version ${reported.application} is not supported. This extension requires Ceedling version ` +
                `${MINIMUM_CEEDLING_VERSION} or higher. Please upgrade your Ceedling installation.`,
        };
    }
    const warning = release.exactRelease ? undefined : `Project '${projectKey}' runs Ceedling ${reported.application} from another installation. ` +
        `Its launcher, Ceedling ${reported.launcher}, can't tell its release, so this extension treats it as ` +
        `${release.release} and discovery waits for runs. Launchers from Ceedling ${firstRelease('reportsApplicationVersion')} ` +
        `report it (Ceedling#1365).`;
    return { kind: 'checked', ceedling: { ...release, capabilities: capabilitiesOf(release.release), launcher }, warning };
}

// One `ceedling version`. Stopped by an exception, it found the project's configuration problem.
// With no version in its output at all, Ceedling itself is unusable.
async function versionReport(
    projectKey: string, withProject: boolean, runVersion: (withProject: boolean) => Promise<CeedlingResult>, log: Pick<Log, 'debug'>,
): Promise<{ kind: 'reported', reported: ReportedCeedling, release: { release: string, exactRelease: boolean } } | Exclude<VersionCheck, { kind: 'checked' }>> {
    const result = await runVersion(withProject);
    const reported = parseCeedlingVersions(result.stdout);
    const release = reported === undefined ? undefined : applicationRelease(reported);
    log.debug(`versionReport(${projectKey}${withProject ? ', with its arguments' : ''}): ${reported === undefined ? 'none' : util.format(reported)}`);
    const exception = exceptionOf(result);
    if (exception !== undefined) {
        return {
            kind: 'configuration',
            message: withException(`Ceedling stopped reporting its version for project '${projectKey}'. Check its project file, the mixins in ` +
                `ceedlingExplorer.mixins and projects[].mixins, and any :project: ↳ :which_ceedling: they set.`, exception),
        };
    }
    if (reported === undefined || release === undefined) {
        return {
            kind: 'unusable',
            message: `Could not run 'ceedling version' for project '${projectKey}'. Check that Ceedling is installed and runs ` +
                `in the configured shell (ceedlingExplorer.shellPath).\n${result.stdout}\n${result.stderr}`,
        };
    }
    return { kind: 'reported', reported, release };
}

// Whether the project runs the release its version check reported. A launcher before 1.2.2
// reports its own release for another build (Ceedling#1365). It never reads the project file,
// so its check stands only when `whichCeedling`, the configuration as last known, selects what it
// sees unaided. With none known, it never stands. From 1.2.2 the check reads the configuration
// the project's commands run with. An edit landing between the check and dumpconfig goes unseen
// until the rediscovery it triggers, as before 1.2.2 between the fingerprint and dumpconfig.
export function releaseKnown(
    ceedling: Pick<ProjectCeedling, 'exactRelease' | 'launcher'>, projectDir: string, whichCeedling: string | undefined, platform: NodeJS.Platform,
): boolean {
    return ceedling.exactRelease && (ceedling.launcher.versionReadsProject ||
        (whichCeedling !== undefined && versionSeesSelection(whichCeedling, projectDir, platform)));
}
