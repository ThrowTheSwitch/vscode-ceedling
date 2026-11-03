// A coverage request's file work: clearing what earlier runs left before a build, and reading the
// Cobertura report after it. Locking is the engine's. It has no `vscode` dependency.
import util from 'util';
import { buildPath, coberturaReportPaths } from './buildLayout';
import type { LoadedProject } from './ceedlingProjectConfig';
import { contextOutput, COVERAGE_PLUGIN, type CoveragePlugin, coverageProblem } from './coveragePlugins';
import { parseCoberturaReport, reportedFiles } from './coberturaReport';
import { deleteFiles, type EngineIo, firstPresent, listUnder, readText } from './engineFileSystem';
import { pathKey } from './platformPaths';
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

// Clears what earlier runs left: stale Cobertura reports before every coverage build, and the
// build directory's coverage counters before the request's first build there. A failed build
// would otherwise leave the last run's report to be read as this one's, and the tools report
// every counter on disk. The counters stay when the user chose to accumulate them.
export async function prepareCoverage(io: EngineIo, project: LoadedProject, mode: CoverageMode, resetsCounters: boolean): Promise<void> {
    const { plugin, run } = mode;
    await deleteFiles(io, coberturaReportPaths(project, plugin, io.paths));
    const key = pathKey(countersDirectory(io, project, plugin), io.platform);
    if (project.state.coverage[plugin] === undefined || run.resets.has(key) || !resetsCounters) {
        return;
    }
    run.resets.add(key);
    await deleteFiles(io, (await counters(io, project, plugin)).map((counter) => counter.file));
}

// Clears one test file's counters before a whole-file run repeats the tests its filtered run just
// counted. They sit beneath each of `places`, the file's build names in the plugin's output, e.g.
// test/unit/test_foo for test/unit/test_foo.c from 1.2.2. Same-named test files elsewhere keep
// theirs. Windows folds case, and keeps whatever case Ceedling created a directory with.
export async function clearTestCounters(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin, places: readonly string[]): Promise<void> {
    const key = (segment: string) => pathKey(segment, io.platform);
    const placed = places.map((place) => place.split('/').map(key));
    const within = (segments: readonly string[], place: readonly string[]) => place.every((segment, i) => segments[i] !== undefined && key(segments[i]) === segment);
    const found = await counters(io, project, plugin);
    await deleteFiles(io, found.filter((counter) => placed.some((place) => within(counter.segments, place))).map((counter) => counter.file));
}

// Why a project can't give coverage through `plugin` at all, or undefined when it can.
export function coverageConfigurationProblem(project: LoadedProject, plugin: CoveragePlugin): string | undefined {
    const state = project.state.coverage[plugin];
    return state === undefined
        ? `Ceedling project '${project.key}' doesn't enable the ${COVERAGE_PLUGIN[plugin].label} plugin, so its tests ran without coverage.`
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
        // A file keeps its candidate that exists, else its first. A sole candidate needs no check.
        const files = await Promise.all(reportedFiles(report, project.absPath, io.paths).map(async ({ candidates, lines, functions }) =>
            ({ path: (candidates.length > 1 ? await firstPresent(io, candidates) : undefined) ?? candidates[0] ?? '', lines, functions })));
        if (files.length === 0) {
            return {
                kind: 'missing',
                message: `The coverage report '${reportPath}' covers no source files. ${advice.noSources}`,
            };
        }
        return { kind: 'report', path: reportPath, files };
    } catch (e) {
        return { kind: 'missing', message: `Could not read the coverage report '${reportPath}': ${util.format(e)}` };
    }
}

function countersDirectory(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin): string {
    return buildPath(project, io.paths, contextOutput(plugin));
}

// The plugin's counter files, each with its directories beneath the plugin's build output.
async function counters(io: EngineIo, project: LoadedProject, plugin: CoveragePlugin): Promise<Array<{ file: string, segments: string[] }>> {
    const directory = countersDirectory(io, project, plugin);
    const files = await listUnder(io, directory);
    return files.filter((file) => COVERAGE_PLUGIN[plugin].reset.counters.test(file))
        .map((file) => ({ file, segments: io.paths.relative(directory, io.paths.dirname(file)).split(/[\\/]/) }));
}
