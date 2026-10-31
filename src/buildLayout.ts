// Where Ceedling builds each test, by release: the layout of its build directories and the names
// it gives them, as Ceedling itself computes them. It has no `vscode` dependency.
import type { LoadedProject } from './ceedlingProjectConfig';
import type { CeedlingCapabilities } from './ceedlingVersions';
import { type PlatformPaths, pathsFor } from './platformPaths';
import type { CeedlingFileNode } from './testModel';

// Beneath the build root: each test's executable and the rest of its build, gcov's counters by
// test, and what test and gcov runs leave behind, the CppUnit and Cobertura reports among them.
export const TEST_OUTPUT = 'test/out';
export const GCOV_OUTPUT = 'gcov/out';
export const TEST_ARTIFACTS = 'artifacts/test';
export const GCOV_ARTIFACTS = 'artifacts/gcov';

// A path within the project's build root, `:project` ↳ `:build_root`, relative to its directory.
export function buildPath(project: Pick<LoadedProject, 'absPath' | 'state'>, paths: PlatformPaths, ...segments: string[]): string {
    return paths.resolve(project.absPath, project.state.buildRoot, ...segments);
}

// Where a run leaves its CppUnit report: a test run under artifacts/test, a gcov run under artifacts/gcov.
export function cppunitReportPaths(project: Pick<LoadedProject, 'absPath' | 'state'>, paths: PlatformPaths): string[] {
    return [TEST_ARTIFACTS, GCOV_ARTIFACTS].map((artifacts) => buildPath(project, paths, artifacts, project.state.reportFilename));
}

// Where the project's Cobertura report may appear, most preferred first.
export function coberturaReportPaths(project: Pick<LoadedProject, 'absPath' | 'state'>, paths: PlatformPaths): string[] {
    return (project.state.coverage?.coberturaReports ?? []).map((report) => buildPath(project, paths, report));
}

// Where a test's build may sit, its release's own place first.
export type Candidates = readonly [string, ...string[]];

// Where Ceedling builds a test file of the project, in `layout`, its release's own by default.
export function projectBuildName(project: LoadedProject, fileId: string, platform: NodeJS.Platform, layout = testBuildLayout(project.capabilities)): string {
    return testBuildName(fileId, layout, { testPaths: project.state.testPaths, projectDir: project.absPath, platform });
}

// Where a test file's executable sits under the test output directory, in `layout`.
export function executablePlace(project: LoadedProject, fileId: string, platform: NodeJS.Platform, layout?: TestBuildLayout): string {
    return `${projectBuildName(project, fileId, platform, layout)}/${testExecutableName(fileId, project.state.executableExtension)}`;
}

// `place(file)` in the release's own layout, then, unless the release is `known`, in each other
// layout where no other test file of the project builds.
export function ownOrUnclaimed(
    file: CeedlingFileNode, files: readonly CeedlingFileNode[], place: (f: CeedlingFileNode, layout?: TestBuildLayout) => string, known: boolean,
): Candidates {
    const own = place(file);
    if (known) {
        return [own];
    }
    const claimed = new Set(files.filter((f) => f.id !== file.id).flatMap((f) => TEST_BUILD_LAYOUTS.map((layout) => place(f, layout))));
    return [own, ...new Set(TEST_BUILD_LAYOUTS.map((layout) => place(file, layout)).filter((p) => p !== own && !claimed.has(p)))];
}

// Which candidate holds the executable, from each one's modification time before and after a
// build: the candidate the build wrote, else the newest that exists, else the release's own. A
// delta build may write nothing, leaving an up-to-date executable as it was, and an older layout's
// copy predates it. `found` is false when no candidate exists.
export function chooseExecutable(before: ReadonlyArray<number | undefined>, after: ReadonlyArray<number | undefined>): { chosen: number, found: boolean } {
    const written = after.findIndex((time, i) => time !== undefined && time !== before[i]);
    const newest = after.reduce<number>((best, time, i) => time !== undefined && (best < 0 || time > (after[best] ?? 0)) ? i : best, -1);
    return { chosen: written >= 0 ? written : Math.max(newest, 0), found: newest >= 0 };
}

// Where a release builds each test: under its base name, under its directory within its test
// path from 1.2.0, or under its path from the project root from 1.2.2. Newest first.
export const TEST_BUILD_LAYOUTS = ['projectPath', 'testRoot', 'flat'] as const;
export type TestBuildLayout = typeof TEST_BUILD_LAYOUTS[number];

export function testBuildLayout(capabilities: CeedlingCapabilities): TestBuildLayout {
    return capabilities.projectPathTestNames ? 'projectPath' : capabilities.nestedTestBuilds ? 'testRoot' : 'flat';
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
    const paths = pathsFor(platform);
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
