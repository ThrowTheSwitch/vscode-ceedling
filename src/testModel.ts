// The test tree discovery produces, and the interface a run reports results through. Engine and
// controller share these types. Ids are scoped to one project, as `file::function` for a
// function and `file::function(args)` for a parametrized case, matching the names in Ceedling's
// reports.

import { type CoverageReport } from './coberturaReport';

export type CeedlingTestCase = { id: string, label: string, line: number };

export type CeedlingTestFunction = {
    id: string,
    label: string,
    line: number,
    // Empty unless the function is parametrized, in which case only the cases get results.
    cases: CeedlingTestCase[],
};

export type CeedlingFileNode = {
    // The project-relative path `ceedling files:test` lists, e.g. `test/test_foo.c`.
    id: string,
    label: string,
    absPath: string,
    projectKey: string,
    functions: CeedlingTestFunction[],
};

export type CeedlingProjectNode = { projectKey: string, label: string, files: CeedlingFileNode[] };

// What a coverage run found: the report read, or why there is none to show.
export type CoverageOutcome =
    | ({ kind: 'report' } & CoverageReport)
    | { kind: 'missing', message: string };

// A run's results for one project. The controller maps ids onto TestItems.
export interface RunReporter {
    started(id: string): void;
    passed(id: string): void;
    // `line` is 0-based, in the test's own file.
    failed(id: string, message: string, line?: number): void;
    skipped(id: string): void;
    // `location` names the compiler diagnostic that best explains a missing report. Its file
    // may be a header or source file rather than the test file.
    errored(id: string, message: string, location?: { file: string, line: number }): void;
    appendOutput(text: string): void;
    // Once per completed coverage build.
    coverage(outcome: CoverageOutcome): void;
}

// The ids that receive results: each parametrized function's cases, else the function itself.
export function leafIds(functions: readonly CeedlingTestFunction[]): string[] {
    return functions.flatMap((fn) => fn.cases.length > 0 ? fn.cases.map((c) => c.id) : [fn.id]);
}

// Every id within a file, the file's own included, for marking a whole file started or errored.
export function allIds(file: CeedlingFileNode): string[] {
    return [file.id, ...file.functions.flatMap((fn) => [fn.id, ...fn.cases.map((c) => c.id)])];
}

// The Testing view names each folder's tests when there is more than one folder.
export function controllerLabel(folderName: string, folderCount: number): string {
    return folderCount > 1 ? `Ceedling (${folderName})` : 'Ceedling';
}
