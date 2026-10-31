// What a build reports to the Testing view: its tests' results from the CppUnit report, or, when
// it gave none, why. It has no `vscode` dependency.
import type { Log } from './log';
import { type MatchedProblem, severityRank } from './problemMatching';
import type { CoverageOutcome, RunReporter } from './testModel';
import { type CppUnitReport, testResults } from './testResults';

const UNREPORTED_MESSAGE =
    "Ceedling reported no result for this test. Its name as found in the source may not match the name Ceedling's test runner gave it.";

// `exception` is Ceedling's own account of why it stopped, when it did.
export type BuildOutcome =
    | { cancelled: true }
    | { cancelled: false, transcript: string, exception: string | undefined, diagnostics: MatchedProblem[], report: CppUnitReport | undefined, coverage: CoverageOutcome | undefined };

type CompletedBuild = Extract<BuildOutcome, { cancelled: false }>;

// A run's output as its tests' messages and the run's output show it, each stream labelled.
export function transcriptOf(output: { stdout: string, stderr: string }): string {
    return [
        output.stdout.length > 0 ? `stdout:\n${output.stdout}` : undefined,
        output.stderr.length > 0 ? `stderr:\n${output.stderr}` : undefined,
    ].filter((section): section is string => section !== undefined).join('\n');
}

// The build's report, for the caller to map, or undefined once a build without one is reported:
// a cancelled build's tests are skipped, and one that wrote no report errors every id.
export function reportOf(outcome: BuildOutcome, ids: readonly string[], leaves: readonly string[], reporter: RunReporter): (CompletedBuild & { report: CppUnitReport }) | undefined {
    if (outcome.cancelled) {
        leaves.forEach((id) => { reporter.skipped(id); });
        return undefined;
    }
    if (outcome.report === undefined) {
        reportMissingReport(ids, outcome, reporter);
        return undefined;
    }
    return { ...outcome, report: outcome.report };
}

// Each leaf's result from the report. A failure's message carries the run's transcript.
export function reportResults(report: CppUnitReport, leaves: readonly string[], transcript: string, reporter: RunReporter, log: Pick<Log, 'warn'>): void {
    const { results, unmapped } = testResults(report, leaves);
    if (unmapped.length > 0) {
        log.warn(`Ceedling reported results matching no discovered test: ${unmapped.join(', ')}`);
    }
    for (const result of results) {
        switch (result.kind) {
            case 'passed': reporter.passed(result.id); break;
            case 'skipped': reporter.skipped(result.id); break;
            case 'failed': reporter.failed(result.id, `${result.message}\n\n${transcript}`, result.line); break;
            case 'unreported': reporter.errored(result.id, `${UNREPORTED_MESSAGE}\n\n${transcript}`); break;
        }
    }
}

// No report means Ceedling stopped before running tests, usually a build failure. The Testing
// view shows a message's first line, so the most severe compiler diagnostic leads, when problem
// matching found one, then Ceedling's exception, then the whole transcript.
function reportMissingReport(ids: readonly string[], build: CompletedBuild, reporter: RunReporter): void {
    const lead = build.diagnostics.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];
    const message = [lead?.message, build.exception, build.transcript].filter((part) => part !== undefined).join('\n\n');
    const location = lead ? { file: lead.file, line: lead.startLine } : undefined;
    for (const id of ids) {
        reporter.errored(id, message, location);
    }
}
