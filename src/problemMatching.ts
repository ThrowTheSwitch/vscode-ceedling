// Problem matching without the editor: the preset patterns, applying a pattern to Ceedling's
// output, and resolving each match's file. It has no `vscode` dependency, so it is unit-tested in
// plain Node. problemMatcher.ts publishes the results to the Problems panel. Paths follow the
// given platform's rules, the host's by default.

import path from 'path';
import util from 'util';
import { outputLines } from './ceedlingOutputParsing';
import type { Log } from './log';

export interface ProblemMatchingPattern {
    scanStdout: boolean;
    scanStderr: boolean;
    severity: string;
    filePrefix: string;
    regexp: string;
    message: number;
    file: number;
    line: number | null;
    lastLine: number | null;
    column: number | null;
    lastColumn: number | null;
}

// One matched problem, independent of vscode.Diagnostic. Line and column are 0-based, as in
// vscode.Position, so a caller builds a Diagnostic from it without index arithmetic.
export interface MatchedProblem {
    file: string;
    message: string;
    severity: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

// Sanitizes patterns from settings, which arrive as untyped user JSON: WorkspaceConfiguration
// doesn't enforce its type parameter. `valid` holds each well-shaped pattern, with defaults filled in as
// the "gcc" preset's are. `invalid` holds the rest, for the caller to log.
export function normalizePatterns(patterns: readonly unknown[]): { valid: ProblemMatchingPattern[], invalid: unknown[] } {
    const valid: ProblemMatchingPattern[] = [];
    const invalid: unknown[] = [];

    for (const candidate of patterns) {
        const get = (key: string): unknown =>
            typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>)[key] : undefined;
        const regexp = get('regexp');
        const message = get('message');
        const file = get('file');
        if (typeof regexp !== 'string' || typeof message !== 'number' || typeof file !== 'number') {
            invalid.push(candidate);
            continue;
        }
        const severity = get('severity');
        const filePrefix = get('filePrefix');
        const index = (key: string) => {
            const value = get(key);
            return typeof value === 'number' ? value : null;
        };
        valid.push({
            scanStdout: get('scanStdout') === true,
            scanStderr: get('scanStderr') !== false,
            severity: severity === 'error' || severity === 'warning' || severity === 'info' ? severity : 'info',
            filePrefix: typeof filePrefix === 'string' ? filePrefix : '',
            regexp,
            message,
            file,
            line: index('line'),
            lastLine: index('lastLine'),
            column: index('column'),
            lastColumn: index('lastColumn'),
        });
    }

    return { valid, invalid };
}

// The built-in "gcc" mode: GCC/Clang warnings and errors, plus a catch-all for a linker error.
// Neither GCC nor Clang tags a linker error with "warning:"/"error:"/"note:", so it needs its own
// pattern. GCC reports a missing header as "fatal error:", which the error pattern accepts and the
// catch-all excludes. Otherwise the catch-all's greedy file group reads `file.c:2:10:` as file
// `file.c:2`, line 10.
//
// The catch-all's optional `(?:\([^)]*\):)?` segment serves GNU ld's "undefined reference"
// line. An older ld prints `file:line: undefined reference to 'sym'`. A newer one inserts a
// section and offset, `file:line:(.text+0xNN): undefined reference to 'sym'`. The whitespace after
// either form stays required. Without it, the catch-all also swallows real warning:/error:/note:
// lines.
export function getGccPatternsPreset(): ProblemMatchingPattern[] {
    return [
        {
            scanStdout: false,
            scanStderr: true,
            severity: 'warning',
            filePrefix: '${projectPath}',
            regexp: '^(.*):(\\d+):(\\d+):\\s+warning:\\s+(.*)$',
            message: 4,
            file: 1,
            line: 2,
            lastLine: null,
            column: 3,
            lastColumn: null
        },
        {
            scanStdout: false,
            scanStderr: true,
            severity: 'error',
            filePrefix: '${projectPath}',
            regexp: '^(.*):(\\d+):(\\d+):\\s+(?:fatal\\s+)?error:\\s+(.*)$',
            message: 4,
            file: 1,
            line: 2,
            lastLine: null,
            column: 3,
            lastColumn: null
        },
        {
            scanStdout: false,
            scanStderr: true,
            severity: 'error',
            filePrefix: '',
            regexp: '^(.*):(\\d+):(?:\\([^)]*\\):)?\\s+(?!(warning:|error:|note:|fatal error:))(.*)$',
            message: 4,
            file: 1,
            line: 2,
            lastLine: null,
            column: null,
            lastColumn: null
        }
    ];
}

export function getPatternsPreset(patternsPreset: string): ProblemMatchingPattern[] {
    return patternsPreset === 'gcc' ? getGccPatternsPreset() : [];
}

// Resolves a matched file against a pattern's prefix. An absolute match is used as is. A compiler
// or linker may report one even where the prefix serves its relative paths, as GNU ld's
// "undefined reference" line does.
export function resolveDiagnosticFilePath(matchedFile: string, filePrefix: string, paths: typeof path.posix = path): string {
    if (filePrefix === '' || paths.isAbsolute(matchedFile)) {
        return paths.normalize(matchedFile);
    }
    return paths.join(paths.normalize(filePrefix), paths.normalize(matchedFile));
}

// Turns one regex match into a MatchedProblem, with 0-based positions. undefined when a configured
// group index is out of range, the file or message group didn't participate, or a captured line or
// column isn't a number. A line or column of 0, as GCC reports for `<command-line>`, places the
// problem at the start.
export function matchToProblem(
    matches: RegExpExecArray, file: number, message: number, severity: string, filePrefix: string,
    line: number | null, lastLine: number | null, column: number | null, lastColumn: number | null, paths: typeof path.posix = path,
): MatchedProblem | undefined {
    const indexInBounds = (index: number | null) => index === null || index < matches.length;
    if (matches.length < 3 || file >= matches.length || message >= matches.length ||
        !indexInBounds(line) || !indexInBounds(lastLine) || !indexInBounds(column) || !indexInBounds(lastColumn)) {
        return undefined;
    }

    // An optional group that didn't participate in the match is undefined despite a valid index.
    const matchedFile = matches[file];
    const messageValue = matches[message];
    if (matchedFile === undefined || messageValue === undefined) {
        return undefined;
    }
    const fileValue = resolveDiagnosticFilePath(matchedFile, filePrefix, paths);
    const lineValue = line !== null ? Number(matches[line]) : undefined;
    const lastLineValue = lastLine !== null ? Number(matches[lastLine]) : undefined;
    const columnValue = column !== null ? Number(matches[column]) : undefined;
    const lastColumnValue = lastColumn !== null ? Number(matches[lastColumn]) : undefined;

    const isNumberOrUndefined = (value: number | undefined) => value === undefined || !Number.isNaN(value);
    if (!isNumberOrUndefined(lineValue) || !isNumberOrUndefined(lastLineValue) ||
        !isNumberOrUndefined(columnValue) || !isNumberOrUndefined(lastColumnValue)) {
        return undefined;
    }

    const zeroBased = (value: number | undefined, absent: number) => value !== undefined ? Math.max(0, value - 1) : absent;
    const startLine = zeroBased(lineValue, 0);
    return {
        file: fileValue,
        message: messageValue,
        severity,
        startLine,
        startColumn: zeroBased(columnValue, 0),
        endLine: zeroBased(lastLineValue, startLine),
        endColumn: zeroBased(lastColumnValue, 999),
    };
}

// Every match of one pattern, line by line, in the streams it scans. `projectPath` replaces a
// literal `${projectPath}` in the pattern's `filePrefix`. Throws for an invalid `regexp`, so a
// caller running several patterns catches per pattern and one bad pattern spares the rest.
export function getPatternProblems(stdout: string, stderr: string, projectPath: string, pattern: ProblemMatchingPattern, paths: typeof path.posix = path): MatchedProblem[] {
    const input = outputLines((pattern.scanStdout ? stdout : '') + '\n' + (pattern.scanStderr ? stderr : ''));
    const regexp = new RegExp(pattern.regexp);
    const filePrefix = pattern.filePrefix.replace(/\$\{projectPath\}/g, projectPath);
    const problems: MatchedProblem[] = [];
    for (const line of input) {
        const matches = regexp.exec(line);
        if (!matches) continue;
        const problem = matchToProblem(matches, pattern.file, pattern.message, pattern.severity, filePrefix,
            pattern.line, pattern.lastLine, pattern.column, pattern.lastColumn, paths);
        if (problem) problems.push(problem);
    }
    return problems;
}

// Every problem the configured patterns find in a run's output: a preset's, or with mode
// "patterns", the user's own. A malformed pattern is dropped, and one whose regexp throws is
// skipped, sparing the rest. Both are logged.
export function matchProblems(
    output: { stdout: string, stderr: string }, projectPath: string, mode: string, patterns: readonly unknown[], log: Pick<Log, 'debug' | 'warn'>,
    paths: typeof path.posix = path,
): MatchedProblem[] {
    let applied: ProblemMatchingPattern[];
    if (mode === 'patterns') {
        const { valid, invalid } = normalizePatterns(patterns);
        for (const dropped of invalid) {
            log.debug(`normalizePatterns: dropping malformed pattern (missing/wrong-typed regexp, message, or file): ${JSON.stringify(dropped)}`);
        }
        applied = valid;
    } else {
        applied = getPatternsPreset(mode);
    }
    const problems: MatchedProblem[] = [];
    for (const pattern of applied) {
        try {
            problems.push(...getPatternProblems(output.stdout, output.stderr, projectPath, pattern, paths));
        } catch (e) {
            log.warn(`match: pattern threw, likely an invalid regexp (${pattern.regexp}): ${util.format(e)}`);
        }
    }
    log.debug(`match: mode=${mode}, patterns=${applied.length}, diagnostics=${problems.length}`);
    return problems;
}

// Errors first, then warnings, then anything else, for choosing the problem that leads a message.
// Patterns run warning, error, then catch-all, so the first found is not reliably the most severe.
export function severityRank(severity: string): number {
    return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

// Whether two problems would show as one in the Problems panel.
export function sameProblem(a: MatchedProblem, b: MatchedProblem): boolean {
    return a.file === b.file && a.message === b.message && a.severity === b.severity &&
        a.startLine === b.startLine && a.startColumn === b.startColumn && a.endLine === b.endLine && a.endColumn === b.endColumn;
}
