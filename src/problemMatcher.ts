import {
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Position,
    Range,
    Uri,
    languages
} from 'vscode';
import path from 'path';
import { Logger } from './logger';

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

export interface FileDiagnostic {
    file: string;
    diagnostic: Diagnostic;
}

export class ProblemMatcher {
    private suitsDiagnostics: Map<string, Array<FileDiagnostic>>;
    private readonly diagnosticCollection: DiagnosticCollection;

    constructor(private readonly logger: Logger) {
        this.suitsDiagnostics = new Map<string, Array<FileDiagnostic>>();
        this.diagnosticCollection = languages.createDiagnosticCollection('Ceedling');
    }

    private normalizePatterns(patterns: ProblemMatchingPattern[]): ProblemMatchingPattern[] {
        //I'm not a TypeScript expert, but it seems like VSCode (v1.48.0; 20 august 2020) has some bug:
        //"WorkspaceConfiguration.get<T>(section: string, defaultValue: T): T" could return anything,
        //requested type not matters. That's why I need to normalize it's output.
        let result: ProblemMatchingPattern[] = [];

        for (const pattern of patterns) {
            if ((pattern.regexp !== undefined) && (typeof pattern.regexp === 'string') &&
                (pattern.message !== undefined) && (typeof pattern.message === 'number') &&
                (pattern.file !== undefined) && (typeof pattern.file === 'number')) {
                let resultPattern: ProblemMatchingPattern = {
                    scanStdout: (pattern.scanStdout === true) ? true : false,
                    scanStderr: (pattern.scanStderr === false) ? false : true,
                    severity: ((pattern.severity === 'error') ||
                        (pattern.severity === 'warning') ||
                        (pattern.severity === 'info'))
                        ? pattern.severity : 'info',
                    filePrefix: ((pattern.filePrefix !== undefined) &&
                        (typeof pattern.filePrefix === 'string'))
                        ? pattern.filePrefix : '',
                    regexp: pattern.regexp,
                    message: pattern.message,
                    file: pattern.file,
                    line: ((pattern.line !== undefined) &&
                        (typeof pattern.line === 'number'))
                        ? pattern.line : null,
                    lastLine: ((pattern.lastLine !== undefined) &&
                        (typeof pattern.lastLine === 'number'))
                        ? pattern.lastLine : null,
                    column: ((pattern.column !== undefined) &&
                        (typeof pattern.column === 'number'))
                        ? pattern.column : null,
                    lastColumn: ((pattern.lastColumn !== undefined) &&
                        (typeof pattern.lastColumn === 'number'))
                        ? pattern.lastColumn : null
                };

                result.push(resultPattern);
            } else {
                this.logger.debug(`normalizePatterns: dropping malformed pattern (missing/wrong-typed regexp, message, or file): ${JSON.stringify(pattern)}`);
            }
        }

        return result;
    }

    private getPatternsPreset(patternsPreset: string): ProblemMatchingPattern[] {
        if (patternsPreset === "gcc") {
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
                    regexp: '^(.*):(\\d+):\\s+(?!(warning:|error:|note:))(.*)$',
                    message: 4,
                    file: 1,
                    line: 2,
                    lastLine: null,
                    column: null,
                    lastColumn: null
                }
            ];
        }
        return [];
    }

    private getFileDiagnosticsFromRegexExec(matches: RegExpExecArray, file: number, message: number,
        severity: DiagnosticSeverity, filePrefix: string,
        line: number | null, lastLine: number | null, column: number | null, lastColumn: number | null
    ): FileDiagnostic | null {
        if ((matches.length < 3) ||
            (file >= matches.length) ||
            (message >= matches.length) ||
            ((line !== null) && (line >= matches.length)) ||
            ((lastLine !== null) && (lastLine >= matches.length)) ||
            ((column !== null) && (column >= matches.length)) ||
            ((lastColumn !== null) && (lastColumn >= matches.length))) {
            this.logger.trace(`getFileDiagnosticsFromRegexExec: rejecting match, a configured group index is out of bounds ` +
                `(matches.length=${matches.length}, file=${file}, message=${message}, line=${line}, lastLine=${lastLine}, column=${column}, lastColumn=${lastColumn})`);
            return null;
        }

        const fileValue = (filePrefix === '') ? path.normalize(matches[file]) : path.join(path.normalize(filePrefix), path.normalize(matches[file]));
        const messageValue = matches[message];
        const lineValue = (line !== null) ? Number(matches[line]) : undefined;
        const lastLineValue = (lastLine !== null) ? Number(matches[lastLine]) : undefined;
        const columnValue = (column !== null) ? Number(matches[column]) : undefined;
        const lastColumnValue = (lastColumn !== null) ? Number(matches[lastColumn]) : undefined;

        if ((fileValue === undefined) ||
            (messageValue === undefined) ||
            ((lineValue !== undefined) && Number.isNaN(lineValue)) ||
            ((lastLineValue !== undefined) && Number.isNaN(lastLineValue)) ||
            ((columnValue !== undefined) && Number.isNaN(columnValue)) ||
            ((lastColumnValue !== undefined) && Number.isNaN(lastColumnValue))) {
            this.logger.trace(`getFileDiagnosticsFromRegexExec: rejecting match, a captured line/column value is missing or not a number ` +
                `(line=${lineValue}, lastLine=${lastLineValue}, column=${columnValue}, lastColumn=${lastColumnValue})`);
            return null;
        }

        const range = new Range(
            new Position((lineValue !== undefined) ? lineValue - 1 : 0,
                (columnValue !== undefined) ? columnValue - 1 : 0),
            new Position((lastLineValue !== undefined) ? lastLineValue - 1 :
                ((lineValue !== undefined) ? lineValue - 1 : 0),
                (lastColumnValue !== undefined) ? lastColumnValue - 1 : 999)
        );

        let resultDiagnostic = new Diagnostic(range, messageValue, severity);
        resultDiagnostic.source = 'Ceedling';

        return {
            file: fileValue,
            diagnostic: resultDiagnostic
        };
    }

    private getPatternDiagnostics(stdout: string, stderr: string, projectPath: string, pattern: ProblemMatchingPattern): FileDiagnostic[] {
        let result: FileDiagnostic[] = [];

        try {
            const input = ((pattern.scanStdout ? stdout : '') + '\n' + (pattern.scanStderr ? stderr : '')).split(/\r?\n/);
            const regexp = new RegExp(pattern.regexp);
            const severity = pattern.severity === 'error' ? DiagnosticSeverity.Error :
                (pattern.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information);
            const filePrefix = pattern.filePrefix.replace(/\$\{projectPath\}/g, projectPath);
            for (const line of input) {
                const matches = regexp.exec(line);
                if (matches) {
                    const fileDiagnostic = this.getFileDiagnosticsFromRegexExec(matches, pattern.file, pattern.message, severity,
                        filePrefix, pattern.line, pattern.lastLine, pattern.column, pattern.lastColumn);
                    if (fileDiagnostic !== null) {
                        result.push(fileDiagnostic);
                    }
                }
            }
        } catch (e) {
            this.logger.warn(`getPatternDiagnostics: pattern threw, likely an invalid regexp (${pattern.regexp}): ${e}`);
        }

        return result;
    }

    private compareDiagnostics(a: Diagnostic, b: Diagnostic): boolean {
        if ((a.message !== b.message) ||
            (a.severity !== b.severity) ||
            (a.range.start.line !== b.range.start.line) ||
            (a.range.start.character !== b.range.start.character) ||
            (a.range.end.line !== b.range.end.line) ||
            (a.range.end.character !== b.range.end.character) ||
            (a.source !== b.source)) {
            return false;
        }

        return true;
    }

    private updateDiagnosticsCollection() {
        let fileDiagnosticsSets: Map<string, Array<Diagnostic>> = new Map<string, Array<Diagnostic>>();
        this.suitsDiagnostics.forEach((value: Array<FileDiagnostic>, key: string) => {
            for (const fileDiagnostic of value) {
                if (!fileDiagnosticsSets.has(fileDiagnostic.file)) {
                    fileDiagnosticsSets.set(fileDiagnostic.file, new Array<Diagnostic>());
                }
                const diagnostics = fileDiagnosticsSets.get(fileDiagnostic.file)!;
                if (!diagnostics.some((value) => {
                    return this.compareDiagnostics(value, fileDiagnostic.diagnostic);
                })) {
                    diagnostics.push(fileDiagnostic.diagnostic);
                }
            }
        });
        this.diagnosticCollection.clear();
        fileDiagnosticsSets.forEach((value: Array<Diagnostic>, key: string) => {
            this.diagnosticCollection.set(Uri.file(key), value);
        });
    }

    // Also returns everything it found, alongside its usual side effect of updating the Problems
    // panel. A caller with a specific failure to explain (e.g. a compile failure with no XML test
    // report) can reuse this same parse instead of re-deriving it.
    scan(id: string, stdout: string, stderr: string, projectPath: string, mode: string, patterns: ProblemMatchingPattern[]): FileDiagnostic[] {
        patterns = (mode === "patterns") ? this.normalizePatterns(patterns) : this.getPatternsPreset(mode);
        let allPatternsDiagnostics: FileDiagnostic[] = [];
        for (const pattern of patterns) {
            const patternDiagnostics = this.getPatternDiagnostics(stdout, stderr, projectPath, pattern);
            allPatternsDiagnostics = allPatternsDiagnostics.concat(patternDiagnostics);
        }
        this.logger.debug(`scan(id=${id}): mode=${mode}, patterns=${patterns.length}, diagnostics=${allPatternsDiagnostics.length}`);
        this.suitsDiagnostics.set(id, allPatternsDiagnostics);
        this.updateDiagnosticsCollection();
        return allPatternsDiagnostics;
    }

    setActualIds(actualIds: string[]) {
        const currentIds = this.suitsDiagnostics.keys();
        for (const id of currentIds) {
            if (!actualIds.includes(id)) {
                this.suitsDiagnostics.delete(id);
            }
        }
        this.updateDiagnosticsCollection();
    }

    clear() {
        this.suitsDiagnostics.clear();
        this.diagnosticCollection.clear();
    }

    dispose(): void {
        this.clear();
        this.diagnosticCollection.dispose();
    }
}
