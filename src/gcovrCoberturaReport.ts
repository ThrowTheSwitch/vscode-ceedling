// Reads a Cobertura XML coverage report, as Ceedling's gcov plugin writes one through gcovr, into
// plain per-file line, branch, and function coverage. It has no `vscode` or filesystem dependency,
// so it is unit-tested in plain Node. Choosing among a file's candidate paths is the engine's job,
// since only the filesystem knows which exists.

import type path from 'path';
import xml2js from 'xml2js';

export type CoveredLine = {
    // 1-based, as Cobertura numbers lines.
    line: number,
    hits: number,
    // One entry per branch outcome on the line, true when taken. Empty for a plain statement.
    branches: boolean[],
};

export type CoveredFunction = { name: string, line: number, hits: number };

export type CoveredFile = { path: string, lines: CoveredLine[], functions: CoveredFunction[] };

// A report's files with their names exactly as written, relative to one of `sources` or absolute.
export type CoberturaReport = {
    sources: string[],
    files: Array<{ filename: string, lines: CoveredLine[], functions: CoveredFunction[] }>,
};

// Rejects malformed XML, and a document without a <coverage> root.
export async function parseCoberturaReport(text: string): Promise<CoberturaReport> {
    return readCoberturaReport(await new xml2js.Parser({ explicitArray: false }).parseStringPromise(text));
}

// Reads a report as xml2js parses it with `explicitArray: false`. That option yields a bare object
// for a container holding one child, and an empty string for an empty self-closing container. Both
// become lists here. A compiled but never executed file still appears, with every line at zero hits.
export function readCoberturaReport(parsedXml: unknown): CoberturaReport {
    const coverage = field(parsedXml, 'coverage');
    if (typeof coverage !== 'object' || coverage === null) {
        throw new Error('The coverage report has no <coverage> element.');
    }
    const files: CoberturaReport['files'] = [];
    for (const pkg of list(field(field(coverage, 'packages'), 'package'))) {
        for (const cls of list(field(field(pkg, 'classes'), 'class'))) {
            const filename = text(attribute(cls, 'filename'));
            if (filename !== '') {
                files.push({ filename, lines: readLines(field(cls, 'lines')), functions: readFunctions(field(cls, 'methods')) });
            }
        }
    }
    return { sources: list(field(field(coverage, 'sources'), 'source')).map(text).filter((source) => source !== ''), files };
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
// build directories, add up per file. Hits sum, and a branch outcome counts as taken if any report
// took it. `keyOf` compares paths, e.g. case-insensitively on Windows.
export function mergeCoverage(reports: ReadonlyArray<{ path: string, files: CoveredFile[] }>, keyOf: (filePath: string) => string): CoveredFile[] {
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

function readLines(container: unknown): CoveredLine[] {
    const lines: CoveredLine[] = [];
    for (const line of list(field(container, 'line'))) {
        const number = Number(attribute(line, 'number'));
        const hits = Number(attribute(line, 'hits'));
        if (Number.isFinite(number) && Number.isFinite(hits)) {
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
        const first = list(field(field(method, 'lines'), 'line'))[0];
        const line = Number(attribute(first, 'number'));
        const hits = Number(attribute(first, 'hits'));
        if (name !== '' && Number.isFinite(line)) {
            functions.push({ name, line, hits: Number.isFinite(hits) ? hits : 0 });
        }
    }
    return functions;
}

// `condition-coverage` reads like "50% (1/2)": how many outcomes were taken, not which. The taken
// ones are listed first, which gives the covered-to-total ratio a consumer needs.
function branchOutcomes(conditionCoverage: unknown): boolean[] {
    const match = /\((\d+)\/(\d+)\)/.exec(text(conditionCoverage));
    const covered = Number(match?.[1]);
    const total = Number(match?.[2]);
    return Number.isFinite(covered) && Number.isFinite(total) && total > 0 ? Array.from({ length: total }, (_, i) => i < covered) : [];
}

function list(value: unknown): unknown[] {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

// The value at `key` when `value` is an object, else undefined. Parsed XML is untyped.
function field(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

// xml2js puts an element's attributes under `$`.
function attribute(element: unknown, name: string): unknown {
    return field(field(element, '$'), name);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
