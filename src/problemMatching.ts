// Problem matching without the editor: the preset patterns, applying a pattern to Ceedling's
// output, and resolving each match's file. It has no `vscode` dependency, so it is unit-tested in
// plain Node. problemMatcher.ts publishes the results to the Problems panel.

import path from 'path';

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

// Sanitizes patterns from settings. WorkspaceConfiguration.get<T> doesn't enforce its type, and
// user JSON can hold anything. `valid` holds each well-shaped pattern, with defaults filled in as
// the "gcc" preset's are. `invalid` holds the rest, for the caller to log.
export function normalizePatterns(patterns: ProblemMatchingPattern[]): { valid: ProblemMatchingPattern[], invalid: unknown[] } {
    const valid: ProblemMatchingPattern[] = [];
    const invalid: unknown[] = [];

    for (const pattern of patterns) {
        const wellShaped = (pattern.regexp !== undefined) && (typeof pattern.regexp === 'string') &&
            (pattern.message !== undefined) && (typeof pattern.message === 'number') &&
            (pattern.file !== undefined) && (typeof pattern.file === 'number');
        if (!wellShaped) {
            invalid.push(pattern);
            continue;
        }
        valid.push({
            scanStdout: pattern.scanStdout === true,
            scanStderr: pattern.scanStderr !== false,
            severity: (pattern.severity === 'error' || pattern.severity === 'warning' || pattern.severity === 'info')
                ? pattern.severity : 'info',
            filePrefix: (pattern.filePrefix !== undefined && typeof pattern.filePrefix === 'string') ? pattern.filePrefix : '',
            regexp: pattern.regexp,
            message: pattern.message,
            file: pattern.file,
            line: (pattern.line !== undefined && typeof pattern.line === 'number') ? pattern.line : null,
            lastLine: (pattern.lastLine !== undefined && typeof pattern.lastLine === 'number') ? pattern.lastLine : null,
            column: (pattern.column !== undefined && typeof pattern.column === 'number') ? pattern.column : null,
            lastColumn: (pattern.lastColumn !== undefined && typeof pattern.lastColumn === 'number') ? pattern.lastColumn : null,
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
export function resolveDiagnosticFilePath(matchedFile: string, filePrefix: string): string {
    if (filePrefix === '' || path.isAbsolute(matchedFile)) {
        return path.normalize(matchedFile);
    }
    return path.join(path.normalize(filePrefix), path.normalize(matchedFile));
}

// Turns one regex match into a MatchedProblem. undefined when a configured group index is out of
// range, or a captured line or column isn't a number.
export function matchToProblem(
    matches: RegExpExecArray, file: number, message: number, severity: string, filePrefix: string,
    line: number | null, lastLine: number | null, column: number | null, lastColumn: number | null
): MatchedProblem | undefined {
    const indexInBounds = (index: number | null) => index === null || index < matches.length;
    if (matches.length < 3 || file >= matches.length || message >= matches.length ||
        !indexInBounds(line) || !indexInBounds(lastLine) || !indexInBounds(column) || !indexInBounds(lastColumn)) {
        return undefined;
    }

    const fileValue = resolveDiagnosticFilePath(matches[file], filePrefix);
    const messageValue = matches[message];
    const lineValue = line !== null ? Number(matches[line]) : undefined;
    const lastLineValue = lastLine !== null ? Number(matches[lastLine]) : undefined;
    const columnValue = column !== null ? Number(matches[column]) : undefined;
    const lastColumnValue = lastColumn !== null ? Number(matches[lastColumn]) : undefined;

    const isNumberOrUndefined = (value: number | undefined) => value === undefined || !Number.isNaN(value);
    if (fileValue === undefined || messageValue === undefined ||
        !isNumberOrUndefined(lineValue) || !isNumberOrUndefined(lastLineValue) ||
        !isNumberOrUndefined(columnValue) || !isNumberOrUndefined(lastColumnValue)) {
        return undefined;
    }

    const startLine = lineValue !== undefined ? lineValue - 1 : 0;
    return {
        file: fileValue,
        message: messageValue,
        severity,
        startLine,
        startColumn: columnValue !== undefined ? columnValue - 1 : 0,
        endLine: lastLineValue !== undefined ? lastLineValue - 1 : startLine,
        endColumn: lastColumnValue !== undefined ? lastColumnValue - 1 : 999,
    };
}

// Every match of one pattern, line by line, in the streams it scans. `projectPath` replaces a
// literal `${projectPath}` in the pattern's `filePrefix`. Throws for an invalid `regexp`, so a
// caller running several patterns catches per pattern and one bad pattern spares the rest.
export function getPatternProblems(stdout: string, stderr: string, projectPath: string, pattern: ProblemMatchingPattern): MatchedProblem[] {
    const input = ((pattern.scanStdout ? stdout : '') + '\n' + (pattern.scanStderr ? stderr : '')).split(/\r?\n/);
    const regexp = new RegExp(pattern.regexp);
    const filePrefix = pattern.filePrefix.replace(/\$\{projectPath\}/g, projectPath);
    const problems: MatchedProblem[] = [];
    for (const line of input) {
        const matches = regexp.exec(line);
        if (!matches) continue;
        const problem = matchToProblem(matches, pattern.file, pattern.message, pattern.severity, filePrefix,
            pattern.line, pattern.lastLine, pattern.column, pattern.lastColumn);
        if (problem) problems.push(problem);
    }
    return problems;
}
