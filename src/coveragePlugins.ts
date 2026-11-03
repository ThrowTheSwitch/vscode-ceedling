// The Ceedling plugins a coverage run can measure through, and everything that differs between
// them: how a project configures each, where its builds and reports go, how a request clears what
// earlier runs counted, and what to tell a user whose project shows nothing. The rest of the
// extension derives its coverage behavior from this table. It has no `vscode` dependency.
import { field, stringList, stringSetting } from './parsedXml';

// A plugin's name is also its `:plugins` ↳ `:enabled` entry, its task prefix, e.g. `gcov:`, and
// the build context Ceedling builds its instrumented tests in.
export const COVERAGE_PLUGINS = ['gcov'] as const;
export type CoveragePlugin = typeof COVERAGE_PLUGINS[number];

// Ceedling's test build contexts: plain test builds, then each coverage plugin's. Each builds under
// <build>/<context>/out and reports under <build>/artifacts/<context>.
export type TestContext = 'test' | CoveragePlugin;
export const TEST_CONTEXTS: readonly TestContext[] = ['test', ...COVERAGE_PLUGINS];

export function contextOutput(context: TestContext): string {
    return `${context}/out`;
}

export function contextArtifacts(context: TestContext): string {
    return `artifacts/${context}`;
}

// What a coverage run leaves to read, for one plugin a project enables.
export type CoverageState = {
    // Coverage runs leave reports only through the plugin's `report:` task, e.g. `report:gcov`.
    reportTask: boolean,
    // Where a Cobertura report may appear, relative to the build root, most preferred first. Empty
    // when the project's configuration writes none.
    coberturaReports: string[],
};

// Each plugin's state, or undefined for a plugin the project doesn't enable. Every plugin has a key.
export type CoverageStates = Readonly<Record<CoveragePlugin, CoverageState | undefined>>;

// How a coverage request clears what earlier runs counted, before its first build. gcov's counter
// files sit beneath the plugin's build output, each test's beneath its own build directory, so a
// test's counters can go alone.
type CounterReset = { kind: 'delete', counters: RegExp };

type CoveragePluginInfo = {
    // The plugin's name in messages.
    label: string,
    reset: CounterReset,
    // The plugin's state, from a resolved configuration that enables it.
    state: (resolved: unknown) => CoverageState,
    // What to do when the configuration writes no Cobertura report, when a run wrote none, and when
    // the report covers no sources.
    advice: { cobertura: string, noReport: string, noSources: string },
    // The documentation section on what the plugin needs.
    page: string,
};

const SITE = 'https://docs.throwtheswitch.org/vscode-ceedling/latest/';

export const COVERAGE_PLUGIN: Readonly<Record<CoveragePlugin, CoveragePluginInfo>> = {
    gcov: {
        label: 'gcov',
        // gcov's counters (.gcda), and the .gcov files gcov writes from them for ReportGenerator.
        reset: { kind: 'delete', counters: /\.(gcda|gcov)$/ },
        state: gcovState,
        advice: {
            cobertura: 'Add Cobertura to :gcov: ↳ :reports:, with gcovr or ReportGenerator among :gcov: ↳ :utilities:.',
            noReport: 'Check that gcovr or ReportGenerator runs in the configured shell.',
            noSources: 'gcovr reports only sources beneath :gcov: ↳ :gcovr: ↳ :report_root:, the project directory by default.',
        },
        page: `${SITE}manual/code-coverage/#what-coverage-needs`,
    },
};

export function coverageStates(resolved: unknown): CoverageStates {
    const enabled = stringList(field(resolved, ':plugins', ':enabled'));
    return Object.fromEntries(COVERAGE_PLUGINS.map((plugin) =>
        [plugin, enabled.includes(plugin) ? COVERAGE_PLUGIN[plugin].state(resolved) : undefined])) as Record<CoveragePlugin, CoverageState | undefined>;
}

// What a project must configure before a coverage run through `plugin` can show anything, or undefined.
export function coverageProblem(projectKey: string, plugin: CoveragePlugin, state: CoverageState): string | undefined {
    const { advice, page } = COVERAGE_PLUGIN[plugin];
    return state.coberturaReports.length > 0 ? undefined :
        `Ceedling project '${projectKey}' writes no Cobertura coverage report, so Run with Coverage has nothing to show. ` +
        `${advice.cobertura} The Code Coverage page explains each: ${page}`;
}

// The gcov plugin writes Cobertura through gcovr, ReportGenerator, or both, into fixed directories.
// Ceedling compares utility and report names case-insensitively, and with no :utilities: listed the
// plugin uses gcovr. ReportGenerator nests its own report in a subdirectory when it writes several
// report types.
function gcovState(resolved: unknown): CoverageState {
    const artifacts = contextArtifacts('gcov');
    const names = (value: unknown) => stringList(value).map((name) => name.toLowerCase());
    const listed = names(field(resolved, ':gcov', ':utilities'));
    const utilities = listed.length > 0 ? listed : ['gcovr'];
    const cobertura = names(field(resolved, ':gcov', ':reports')).includes('cobertura');
    const coberturaReports = !cobertura ? [] : [
        ...utilities.includes('gcovr') ? [`${artifacts}/gcovr/${stringSetting(resolved, 'GcovCoverageCobertura.xml', ':gcov', ':gcovr', ':cobertura_artifact_filename')}`] : [],
        ...utilities.includes('reportgenerator') ? [`${artifacts}/ReportGenerator/Cobertura.xml`, `${artifacts}/ReportGenerator/Cobertura/Cobertura.xml`] : [],
    ];
    return { reportTask: field(resolved, ':gcov', ':report_task') === true, coberturaReports };
}
