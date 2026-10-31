// Where Ceedling builds each test, by release: the layout of its build directories and the names
// it gives them, as Ceedling itself computes them. It has no `vscode` dependency.
import type { CeedlingCapabilities } from './ceedlingVersions';
import { pathsFor } from './platformPaths';

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
