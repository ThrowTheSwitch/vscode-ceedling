// The Ceedling plugins a coverage run can measure through, and everything that differs between
// them: how a project configures each, where its builds and reports go, how a request clears what
// earlier runs counted, and what to tell a user whose project shows nothing. The rest of the
// extension derives its coverage behavior from this table. It has no `vscode` dependency.
import { field, stringList, stringSetting, text } from './parsedXml';

// A plugin's name is also its `:plugins` ↳ `:enabled` entry, its task prefix, e.g. `gcov:`, and
// the build context Ceedling builds its instrumented tests in.
export const COVERAGE_PLUGINS = ['gcov', 'bullseye'] as const;
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

// How a coverage request clears what earlier runs counted, before its first build.
// - delete: counter files beneath the plugin's build output, each test's beneath its own build
//   directory, so a test's counters can go alone. A rebuilt test writes them afresh.
// - covclear: one coverage file in the project directory, which also holds the instrumentation a
//   build compiled in. Bullseye's covclear zeroes its measurements in place, since a delta build
//   that compiles nothing would measure into nothing once the file is gone. Bullseye records
//   whether each probe ran, not how often, so a test run twice needs no reset of its own.
type CounterReset =
    | { kind: 'delete', counters: RegExp }
    // `advice` is what to check when covclear fails.
    | { kind: 'covclear', covfile: string, advice: string };

// Bullseye's reset, run in the project directory and given the coverage file there by name, so no
// project path reaches the shell. A covclear waiting on an unreachable floating license fails after
// its timeout.
export const COVCLEAR = { command: 'covclear', args: (covfile: string): string[] => ['-q', '--file', covfile], timeoutMs: 120_000 };

type CoveragePluginInfo = {
    // The plugin's name in messages.
    label: string,
    reset: CounterReset,
    // The plugin's state, from a resolved configuration that enables it.
    state: (resolved: unknown) => CoverageState,
    // What to do when the configuration writes no Cobertura report, when a run wrote none, and when
    // the report covers no sources.
    advice: { cobertura: string, noReport: string, noSources: string },
    // The documentation section on what the plugin needs, written out whole so the docs tests check it.
    page: string,
};

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
        page: 'https://docs.throwtheswitch.org/vscode-ceedling/latest/manual/code-coverage/gcov/#what-gcov-coverage-needs',
    },
    bullseye: {
        label: 'Bullseye',
        // Relative to the project directory, where Ceedling runs. The plugin sets COVFILE to it over any
        // :environment of the user's.
        reset: {
            kind: 'covclear',
            covfile: 'test.cov',
            advice: "Check that Bullseye's tools are on the configured shell's PATH, and that Bullseye is licensed, as `ceedling bullseye:license` reports.",
        },
        state: bullseyeState,
        advice: {
            cobertura: "Set :bullseye: ↳ :xml_report: to :cobertura. Its :native report is Bullseye's own XML, which VS Code can't show.",
            noReport: "Check that Bullseye's covxml runs in the configured shell, and that Bullseye is licensed, as `ceedling bullseye:license` reports.",
            noSources: "Bullseye's reports leave out test files, mocks, and the Unity, CMock, and CException frameworks.",
        },
        page: 'https://docs.throwtheswitch.org/vscode-ceedling/latest/manual/code-coverage/bullseye/#what-bullseye-coverage-needs',
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
        `${advice.cobertura} See ${page}`;
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

// The Bullseye plugin writes Cobertura through covxml only with :xml_report: :cobertura, which
// dumpconfig shows as the YAML string ':cobertura'.
function bullseyeState(resolved: unknown): CoverageState {
    return {
        reportTask: field(resolved, ':bullseye', ':report_task') === true,
        coberturaReports: text(field(resolved, ':bullseye', ':xml_report')) === ':cobertura' ? [`${contextArtifacts('bullseye')}/coverage.xml`] : [],
    };
}
