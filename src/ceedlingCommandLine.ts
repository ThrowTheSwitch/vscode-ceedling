// The command lines the engine gives Ceedling for a project: the --project/--mixin flags every
// command takes, and the tasks that run a test file. Tokens are raw. CeedlingRunner quotes them
// when it builds the command line. It has no `vscode` dependency.
import type { CoverageState, LoadedProject } from './ceedlingProjectConfig';
import { firstRelease } from './ceedlingVersions';
import type { PlatformPaths } from './platformPaths';

// Added to test runs and debug builds in development mode only, for the extension's own logs.
export const DEBUG_VERBOSITY = ['--verbosity', 'debug'];

// Builds the --project/--mixin flags common to every Ceedling invocation for a project, in
// Ceedling's own priority order. --project names the base project file, project.yml or
// ceedling.yml. A later --mixin flag outranks an earlier one, and a mixin's lists merge by
// prepending onto the existing list rather than replacing it. Lowest to highest priority: the
// configured project file when it isn't the base (ceedlingExplorer.projects[].path naming another
// yml), the user's configured mixins (already resolved into one ordered list), then the
// extension's own report-plugin mixin, always last so it always wins.
export function buildProjectArgs(projectFileName: string, ymlFileName: string, userMixins: readonly string[], bundledMixinPath: string): string[] {
    const args = ['--project', projectFileName];
    if (ymlFileName !== projectFileName) {
        args.push('--mixin', ymlFileName);
    }
    for (const mixin of userMixins) {
        args.push('--mixin', mixin);
    }
    args.push('--mixin', bundledMixinPath);
    return args;
}

// The tasks that run one test file, or `all`: the configured arguments, `${TEST_ID}` in each
// becoming the file. That is its project-relative path where Ceedling accepts one, which tells
// same-named files apart, else its name alone. `testCaseFilter` appends Ceedling's --test-case
// flag, which enables the runner's command-line arguments itself.
// A coverage run (`coverage`, the project's gcov plugin) takes `coverageCommandArgs`. Before 1.2.1,
// Ceedling's gcov: task prepends the test file prefix to a name lacking it, so it takes only the
// bare file name, which can't tell same-named test files apart. `warning` says so when it matters.
// Reports deferred to the report:gcov task are generated in the same run.
export function taskArgs(
    project: LoadedProject, testId: string, coverage: CoverageState | undefined, configured: readonly string[], testCaseFilter: string | undefined, paths: PlatformPaths,
): { args: string[], warning: string | undefined } {
    const byPath = coverage ? project.capabilities.pathQualifiedCoverageTasks : project.capabilities.pathQualifiedTestTasks;
    const bareName = (id: string) => paths.basename(id.replace(/\\/g, '/'));
    const testFile = byPath ? testId : bareName(testId);
    const namesakes = coverage && !byPath ? project.files.filter((f) => f.id !== testId && bareName(f.id) === testFile) : [];
    // A Ceedling that resolves test: tasks by path refuses the bare name as ambiguous.
    const warning = namesakes.length === 0 ? undefined :
        `A coverage run of '${testId}' names it '${testFile}', which Ceedling ${project.release} can't tell apart from ` +
        `${namesakes.map((f) => `'${f.id}'`).join(', ')}. ` +
        (project.capabilities.pathQualifiedTestTasks ? 'It stops with an ambiguous file reference error. ' : 'It may run the other file. ') +
        `Ceedling ${firstRelease('pathQualifiedCoverageTasks')} and later take its path.`;
    const args = configured.map((arg) => arg.replaceAll('${TEST_ID}', testFile));
    if (coverage?.reportTask && !args.includes('report:gcov')) {
        args.push('report:gcov');
    }
    return { args: testCaseFilter === undefined ? args : [...args, `--test-case=${testCaseFilter}`], warning };
}
