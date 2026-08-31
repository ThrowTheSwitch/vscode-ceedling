// Pure, `vscode`-free problem-matching logic: preset patterns, applying a pattern's regex to
// Ceedling's stdout/stderr, and resolving each match's file path. Kept free of any `vscode`
// dependency so it can be unit-tested directly in plain Node (see
// tests/unit/problemMatching.test.ts), the same way ceedlingOutputParsing.ts is. problemMatcher.ts
// holds a Logger, which needs a real VS Code output channel - that class can only run inside the
// Extension Host, so this logic lives here instead.

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

// One matched problem, independent of vscode.Diagnostic. Line and column are already 0-based,
// matching vscode.Position's own convention - a caller builds a real Diagnostic from this
// directly, with no further index math.
export interface MatchedProblem {
    file: string;
    message: string;
    severity: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

// Sanitizes a settings-provided patterns array. VS Code's WorkspaceConfiguration.get<T> does not
// actually guarantee the requested type - user JSON can contain anything. `valid` keeps every
// well-shaped pattern, defaulted the same way the "gcc" preset's own patterns are shaped.
// `invalid` keeps whatever was dropped, for a caller to log.
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

// The built-in "gcc" mode: GCC/Clang warnings and errors, plus a catch-all for a linker error -
// neither GCC nor Clang tag a linker error with "warning:"/"error:"/"note:", so it needs its own
// pattern.
//
// The catch-all's optional `(?:\([^)]*\):)?` segment exists for GNU ld's "undefined reference"
// line. Confirmed against two real ld versions: an older one prints
// "file:line: undefined reference to 'sym'" directly; a newer one inserts a section+offset first,
// "file:line:(.text+0xNN): undefined reference to 'sym'". Both must still require the whitespace
// that follows - making it optional too let the catch-all wrongly swallow real
// warning:/error:/note: lines instead (confirmed empirically while fixing this).
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
            regexp: '^(.*):(\\d+):(\\d+):\\s+error:\\s+(.*)$',
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
            regexp: '^(.*):(\\d+):(?:\\([^)]*\\):)?\\s+(?!(warning:|error:|note:))(.*)$',
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

// Resolves a matched file path against a pattern's configured prefix. An already-absolute
// matched path is used as-is, regardless of `filePrefix` - a compiler or linker can emit one even
// under a non-empty prefix meant for its usual relative paths (confirmed: GNU ld's "undefined
// reference" line reports an absolute path). Joining a prefix onto an already-absolute path
// produces a nonsense combined path instead.
export function resolveDiagnosticFilePath(matchedFile: string, filePrefix: string): string {
    if (filePrefix === '' || path.isAbsolute(matchedFile)) {
        return path.normalize(matchedFile);
    }
    return path.join(path.normalize(filePrefix), path.normalize(matchedFile));
}

// Turns one regex match into a MatchedProblem. Rejects the match, returning undefined, when a
// configured group index is out of bounds or a captured line/column value isn't a number - the
// same validation problemMatcher.ts always applied, kept identical here.
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

// Applies one pattern's regex to every line of stdout/stderr (as the pattern configures),
// returning every match. `projectPath` fills in a literal `${projectPath}` placeholder in the
// pattern's own `filePrefix`. Throws if `pattern.regexp` is not a valid regular expression - a
// caller with several patterns to run (e.g. every custom pattern from settings) should catch this
// per pattern, so one malformed pattern does not stop the rest from being scanned.
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
