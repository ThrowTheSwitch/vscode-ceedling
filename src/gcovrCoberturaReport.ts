// Pure, `vscode`-free normalization of a parsed gcovr Cobertura XML report (as produced by
// xml2js's `new Parser({ explicitArray: false })` against the output of Ceedling's gcov plugin
// with the `Cobertura` report enabled). Kept free of any `vscode`/`fs` dependency so it can be
// unit-tested directly in plain Node (see tests/unit/gcovrCoberturaReport.test.ts).

import * as path from 'path';

export interface CoveredLine {
    line: number;
    hits: number;
    /** One entry per branch outcome on this line, true when taken. Empty for a plain statement. */
    branches: boolean[];
}

export interface CoveredFunction {
    name: string;
    line: number;
    hits: number;
}

export interface CoveredFile {
    /** Absolute. */
    path: string;
    lines: CoveredLine[];
    functions: CoveredFunction[];
}

// With `explicitArray: false`, a container holding exactly one child parses to a single object
// rather than a one-element array, and an empty self-closing container parses to an empty string.
// Both are normalized to an array here.
function toArray(value: any): any[] {
    if (value === undefined || value === null || value === '') return [];
    return Array.isArray(value) ? value : [value];
}

// `condition-coverage` looks like "50% (1/2)". Only the covered/total pair is usable: gcovr does
// not say *which* outcomes were taken, so the branches are reported as N taken followed by
// (total - N) not taken. That is enough for a covered/total ratio, which is all the consumer needs.
function parseBranches(conditionCoverage: unknown): boolean[] {
    if (typeof conditionCoverage !== 'string') return [];
    const match = /\((\d+)\/(\d+)\)/.exec(conditionCoverage);
    if (match === null) return [];
    const covered = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(covered) || !Number.isFinite(total) || total <= 0) return [];
    return Array.from({ length: total }, (_, i) => i < covered);
}

// Returns one entry per <class> in the report. gcovr emits a <class> per source file; a file that
// was compiled but never executed still appears, with every line at zero hits. `baseDir` is the
// directory gcovr ran in. Throws if the report doesn't have the expected shape; callers are
// expected to catch and log.
export function getCoverageFromCoberturaReport(xmlReportData: any, baseDir: string): CoveredFile[] {
    const coverage = xmlReportData['coverage'];
    const sourceRoot = toArray(coverage['sources']?.['source'])[0] ?? '';
    const files: CoveredFile[] = [];

    for (const pkg of toArray(coverage['packages']?.['package'])) {
        for (const cls of toArray(pkg['classes']?.['class'])) {
            const filename = cls['$']?.['filename'] ?? '';
            if (filename === '') continue;

            const lines: CoveredLine[] = [];
            for (const line of toArray(cls['lines']?.['line'])) {
                const number = Number(line['$']?.['number']);
                const hits = Number(line['$']?.['hits']);
                if (!Number.isFinite(number) || !Number.isFinite(hits)) continue;
                lines.push({
                    line: number,
                    hits,
                    branches: line['$']?.['branch'] === 'true'
                        ? parseBranches(line['$']?.['condition-coverage'])
                        : [],
                });
            }

            const functions: CoveredFunction[] = [];
            for (const method of toArray(cls['methods']?.['method'])) {
                const name = method['$']?.['name'] ?? '';
                // gcovr does not give a method a hit count of its own. Its first line carries it.
                const methodLines = toArray(method['lines']?.['line']);
                const first = methodLines[0];
                const line = Number(first?.['$']?.['number']);
                const hits = Number(first?.['$']?.['hits']);
                if (name === '' || !Number.isFinite(line)) continue;
                functions.push({ name, line, hits: Number.isFinite(hits) ? hits : 0 });
            }

            // <filename> is relative to <source> inside gcovr's root and absolute outside it; <source>
            // is relative to baseDir before gcovr 8.3 (gcovr#1037). path.join would mangle the absolutes.
            files.push({ path: path.resolve(baseDir, String(sourceRoot), String(filename)), lines, functions });
        }
    }

    return files;
}
