// Reads a Cobertura XML coverage report, as Ceedling's gcov plugin writes one through gcovr or
// ReportGenerator, into plain per-file line, branch, and function coverage. It has no `vscode` or filesystem dependency,
// so it is unit-tested in plain Node. Choosing among a file's candidate paths is the engine's job,
// since only the filesystem knows which exists.

import type path from 'path';
import { field, list, parseXml, text } from './parsedXml';

export type CoveredLine = {
    // 1-based, as Cobertura numbers lines.
    line: number,
    hits: number,
    // One entry per branch outcome on the line, true when taken. Empty for a plain statement.
    branches: boolean[],
};

export type CoveredFunction = { name: string, line: number, hits: number };

export type CoveredFile = { path: string, lines: CoveredLine[], functions: CoveredFunction[] };

// One report's files, at their resolved paths.
export type CoverageReport = { path: string, files: CoveredFile[] };

// A report's files with their names exactly as written, relative to one of `sources` or absolute.
export type CoberturaReport = {
    sources: string[],
    files: Array<{ filename: string, lines: CoveredLine[], functions: CoveredFunction[] }>,
};

// Rejects malformed XML, and a document without a <coverage> root.
export async function parseCoberturaReport(text: string): Promise<CoberturaReport> {
    return readCoberturaReport(await parseXml(text));
}

// Reads a report as xml2js parses it with `explicitArray: false`. A compiled but never executed
// file still appears, with every line at zero hits. An empty <coverage/> covers nothing.
export function readCoberturaReport(parsedXml: unknown): CoberturaReport {
    const coverage = field(parsedXml, 'coverage');
    if (coverage === '') {
        return { sources: [], files: [] };
    }
    if (typeof coverage !== 'object' || coverage === null) {
        throw new Error('The coverage report has no <coverage> element.');
    }
    const files: CoberturaReport['files'] = [];
    for (const pkg of list(field(coverage, 'packages', 'package'))) {
        for (const cls of list(field(pkg, 'classes', 'class'))) {
            const filename = text(attribute(cls, 'filename'));
            if (filename !== '') {
                files.push({ filename, lines: readLines(field(cls, 'lines')), functions: readFunctions(field(cls, 'methods')) });
            }
        }
    }
    const sources = list(field(coverage, 'sources', 'source')).map((source) => text(source).trim()).filter((source) => source !== '');
    return { sources, files };
}

// Each file's candidate absolute paths, in the report's source order without duplicates. `baseDir`
// is the directory the coverage tool ran in. A relative <source> is relative to it, as gcovr wrote
// `.` before 8.3 (gcovr#1037), and as ReportGenerator writes the source directories it was given.
// `path.resolve`, unlike `path.join`, keeps an absolute filename absolute.
export function reportedFiles(report: CoberturaReport, baseDir: string, paths: typeof path.posix): Array<{ candidates: string[], lines: CoveredLine[], functions: CoveredFunction[] }> {
    const sources = report.sources.length > 0 ? report.sources : ['.'];
    return report.files.map(({ filename, lines, functions }) => ({
        candidates: [...new Set(sources.map((source) => paths.resolve(baseDir, source, filename)))],
        lines,
        functions,
    }));
}

// One coverage view from a request's reports. A later report at the same path supersedes an earlier
// one, since it counts the counters the earlier one did. Reports at different paths, from separate
// build directories, add up per file, as do two classes naming one file in a report. Hits sum.
// Cobertura counts a line's taken branch outcomes without saying which, so a merged line shows the
// most any report took. `keyOf` compares paths, e.g. case-insensitively on Windows.
export function mergeCoverage(reports: readonly CoverageReport[], keyOf: (filePath: string) => string): CoveredFile[] {
    const latest = new Map<string, CoveredFile[]>();
    for (const report of reports) {
        latest.set(keyOf(report.path), report.files);
    }
    const merged = new Map<string, CoveredFile>();
    for (const file of [...latest.values()].flat()) {
        const key = keyOf(file.path);
        const earlier = merged.get(key);
        merged.set(key, earlier ? combine(earlier, file) : file);
    }
    return [...merged.values()];
}

function combine(a: CoveredFile, b: CoveredFile): CoveredFile {
    const lines = new Map(a.lines.map((line) => [line.line, line]));
    for (const line of b.lines) {
        const other = lines.get(line.line);
        lines.set(line.line, !other ? line : {
            line: line.line,
            hits: other.hits + line.hits,
            branches: Array.from({ length: Math.max(other.branches.length, line.branches.length) }, (_, i) => other.branches[i] === true || line.branches[i] === true),
        });
    }
    const functions = new Map(a.functions.map((fn) => [`${fn.name}:${fn.line}`, fn]));
    for (const fn of b.functions) {
        const other = functions.get(`${fn.name}:${fn.line}`);
        functions.set(`${fn.name}:${fn.line}`, other ? { ...fn, hits: other.hits + fn.hits } : fn);
    }
    return { path: a.path, lines: [...lines.values()].sort((x, y) => x.line - y.line), functions: [...functions.values()] };
}

// A line number counts from 1, and a hit count from 0. Anything else can't be shown, since VS Code
// positions can't be negative, so it is left out.
function lineNumber(value: unknown): number | undefined {
    const number = text(value) === '' ? NaN : Number(value);
    return Number.isInteger(number) && number >= 1 ? number : undefined;
}

function hitCount(value: unknown): number | undefined {
    const hits = text(value) === '' ? NaN : Number(value);
    return Number.isInteger(hits) && hits >= 0 ? hits : undefined;
}

function readLines(container: unknown): CoveredLine[] {
    const lines: CoveredLine[] = [];
    for (const line of list(field(container, 'line'))) {
        const number = lineNumber(attribute(line, 'number'));
        const hits = hitCount(attribute(line, 'hits'));
        if (number !== undefined && hits !== undefined) {
            lines.push({ line: number, hits, branches: attribute(line, 'branch') === 'true' ? branchOutcomes(attribute(line, 'condition-coverage')) : [] });
        }
    }
    return lines;
}

// A method has no hit count of its own in Cobertura. Its first line carries the function's.
function readFunctions(container: unknown): CoveredFunction[] {
    const functions: CoveredFunction[] = [];
    for (const method of list(field(container, 'method'))) {
        const name = text(attribute(method, 'name'));
        const first = list(field(method, 'lines', 'line'))[0];
        const line = lineNumber(attribute(first, 'number'));
        if (name !== '' && line !== undefined) {
            functions.push({ name, line, hits: hitCount(attribute(first, 'hits')) ?? 0 });
        }
    }
    return functions;
}

// No source line has anywhere near this many branch outcomes. A larger count is a corrupt report.
const MAX_BRANCHES_PER_LINE = 1024;

// `condition-coverage` reads like "50% (1/2)": how many outcomes were taken, not which. The taken
// ones are listed first, which gives the covered-to-total ratio a consumer needs.
function branchOutcomes(conditionCoverage: unknown): boolean[] {
    const match = /\((\d+)\/(\d+)\)/.exec(text(conditionCoverage));
    const covered = Number(match?.[1]);
    const total = Number(match?.[2]);
    return Number.isInteger(covered) && Number.isInteger(total) && total > 0 && total <= MAX_BRANCHES_PER_LINE
        ? Array.from({ length: total }, (_, i) => i < covered) : [];
}

// xml2js puts an element's attributes under `$`.
function attribute(element: unknown, name: string): unknown {
    return field(element, '$', name);
}
