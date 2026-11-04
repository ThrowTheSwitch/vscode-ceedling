// A coverage request's work around each build: clearing what earlier runs counted before it, by
// deleting files or running the plugin's own tool, and reading the Cobertura report after it.
// Locking and running tools are the engine's. It has no `vscode` dependency.
import util from 'util';
import { buildPath, coberturaReportPaths } from './buildLayout';
import type { CeedlingResult } from './ceedlingProcess';
import type { LoadedProject } from './ceedlingProjectConfig';
import { contextOutput, COVCLEAR, COVERAGE_PLUGIN, type CoveragePlugin, coverageProblem } from './coveragePlugins';
import { parseCoberturaReport, reportedFiles } from './coberturaReport';
import { deleteFiles, type EngineIo, firstPresent, listUnder, readText } from './engineFileSystem';
import { pathKey, viaLink } from './platformPaths';
import type { CoverageOutcome } from './testModel';

// One coverage request, which may run Ceedling several times. Each place its counters sit is cleared
// before its first build there only, so later builds add to this request's own.
type CoverageRun = { readonly resets: Set<string> };

// A coverage run measures through one plugin, the profile's that started it.
export type RunMode = { kind: 'test' } | { kind: 'coverage', plugin: CoveragePlugin, run: CoverageRun };
export type CoverageMode = Extract<RunMode, { kind: 'coverage' }>;

export const TEST_MODE: RunMode = { kind: 'test' };

export function coverageMode(plugin: CoveragePlugin): CoverageMode {
    return { kind: 'coverage', plugin, run: { resets: new Set() } };
}

// Runs one of a coverage plugin's own tools in the project's directory, with `env` over the
// environment Ceedling runs with. A cancelled request runs none, and gets a cancelled result.
export type CoverageTool = (tool: { command: string, args: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number }) => Promise<CeedlingResult>;

// Clears what earlier runs left: stale Cobertura reports before every coverage build, and the
// counters before the request's first build over them. A failed build would otherwise leave the
// last run's report to be read as this one's, and the tools report every counter there is. The
// counters stay when the user chose to accumulate them. A reset that fails leaves them too, and
// returns a notice saying so.
export async function prepareCoverage(io: EngineIo, project: LoadedProject, mode: CoverageMode, resetsCounters: boolean, runTool: CoverageTool): Promise<CoverageOutcome | undefined> {
    const { plugin, run } = mode;
    const state = project.state.coverage[plugin];
    await deleteFiles(io, coberturaReportPaths(project, plugin, io.paths));
    const store = counterStore(io, project, plugin);
    const key = pathKey(store, io.platform);
    if (state === undefined || run.resets.has(key) || !resetsCounters) {
        return undefined;
    }
    run.resets.add(key);
    const { label, page, reset } = COVERAGE_PLUGIN[plugin];
    if (reset.kind === 'delete') {
        await deleteFiles(io, (await counters(io, project, plugin, reset.counters)).map((counter) => counter.file));
        return undefined;
    }
    // A coverage file no build has made yet holds nothing to reset.
    if (await firstPresent(io, [store]) === undefined) {
        return undefined;
    }
    // Ceedling gives its Bullseye tools :environment, which holds the plugin's own COVLM for a floating license.
    const result = await runTool({ command: COVCLEAR.command, args: COVCLEAR.args(reset.covfile), env: project.state.environment, timeoutMs: COVCLEAR.timeoutMs });
    return !result.error || result.cancelled ? undefined : {
        kind: 'notice',
        message: `Ceedling project '${project.key}' couldn't reset its ${label} coverage file ${store} with ${COVCLEAR.command}, so this run's coverage includes earlier runs'. ` +
            `${reset.advice} See ${page}`,
    };
}

// Clears one test file's counters before a whole-file run repeats the tests its filtered run just
// counted. They sit beneath each of `places`, the file's build names in the plugin's output, e.g.
// test/unit/test_foo for test/unit/test_foo.c from 1.2.2. Same-named test files elsewhere keep
// theirs. Windows folds case, and keeps whatever case Ceedling created a directory with.
// A plugin whose counters can't be told apart by test clears nothing.
export async function clearTestCounters(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin, places: readonly string[]): Promise<void> {
    const { reset } = COVERAGE_PLUGIN[plugin];
    if (reset.kind !== 'delete') {
        return;
    }
    const key = (segment: string) => pathKey(segment, io.platform);
    const placed = places.map((place) => place.split('/').map(key));
    const within = (segments: readonly string[], place: readonly string[]) => place.every((segment, i) => segments[i] !== undefined && key(segments[i]) === segment);
    const found = await counters(io, project, plugin, reset.counters);
    await deleteFiles(io, found.filter((counter) => placed.some((place) => within(counter.segments, place))).map((counter) => counter.file));
}

// Why a project can't give coverage through `plugin` at all, or undefined when it can.
export function coverageConfigurationProblem(project: LoadedProject, plugin: CoveragePlugin): string | undefined {
    const state = project.state.coverage[plugin];
    return state === undefined
        ? `Ceedling project '${project.key}' doesn't enable Ceedling's ${COVERAGE_PLUGIN[plugin].label} plugin, so its tests ran without coverage.`
        : coverageProblem(project.key, plugin, state);
}

// The first Cobertura report present, with each file at its candidate path that exists. Ceedling
// runs the coverage tools in the project directory, which relative report paths start from.
export async function readCoverage(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin): Promise<CoverageOutcome> {
    const problem = coverageConfigurationProblem(project, plugin);
    if (problem !== undefined) {
        return { kind: 'missing', message: problem };
    }
    const { advice } = COVERAGE_PLUGIN[plugin];
    const reportPaths = coberturaReportPaths(project, plugin, io.paths);
    const reportPath = await firstPresent(io, reportPaths);
    if (reportPath === undefined) {
        return {
            kind: 'missing',
            message: `Ceedling project '${project.key}' wrote no coverage report at ${reportPaths.join(' or ')}. ` +
                `${advice.noReport} Ceedling's output in the Test Results panel says more.`,
        };
    }
    try {
        const report = await parseCoberturaReport(await readText(io, reportPath));
        // A tool names sources from its working directory, whose symlinks are resolved, as Ruby's is on
        // macOS for a project beneath /var or /tmp. Each such path's form by way of the project's own
        // path comes first, so coverage lands on the files the editor shows.
        const realDir = await io.fs.realpath(project.absPath);
        const viaProject = (candidate: string) => (realDir === undefined ? undefined : viaLink(candidate, project.absPath, realDir, io.platform)) ?? candidate;
        // A file keeps its candidate that exists, else its first. A sole candidate needs no check.
        const files = await Promise.all(reportedFiles(report, project.absPath, io.paths).map(async ({ candidates: reported, lines, functions }) => {
            const candidates = [...new Set(reported.flatMap((candidate) => [viaProject(candidate), candidate]))];
            return { path: (candidates.length > 1 ? await firstPresent(io, candidates) : undefined) ?? candidates[0] ?? '', lines, functions };
        }));
        if (files.length === 0) {
            return {
                kind: 'missing',
                message: `The coverage report '${reportPath}' covers no source files. ${advice.noSources}`,
            };
        }
        return { kind: 'report', path: reportPath, counters: counterStore(io, project, plugin), files };
    } catch (e) {
        return { kind: 'missing', message: `Could not read the coverage report '${reportPath}': ${util.format(e)}` };
    }
}

// Where the plugin keeps a project's counters: gcov beneath its build output, Bullseye in its
// coverage file. Projects sharing either share their counters.
function counterStore(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin): string {
    const { reset } = COVERAGE_PLUGIN[plugin];
    return reset.kind === 'delete' ? buildPath(project, io.paths, contextOutput(plugin)) : io.paths.resolve(project.absPath, reset.covfile);
}

// The plugin's counter files, each with its directories beneath the plugin's build output.
async function counters(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin, pattern: RegExp): Promise<Array<{ file: string, segments: string[] }>> {
    const directory = buildPath(project, io.paths, contextOutput(plugin));
    const files = await listUnder(io, directory);
    return files.filter((file) => pattern.test(file))
        .map((file) => ({ file, segments: io.paths.relative(directory, io.paths.dirname(file)).split(/[\\/]/) }));
}
