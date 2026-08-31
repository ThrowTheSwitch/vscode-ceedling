import {
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    Position,
    Range,
    Uri,
    languages
} from 'vscode';
import {
    getPatternProblems,
    getPatternsPreset,
    MatchedProblem,
    normalizePatterns,
    ProblemMatchingPattern,
} from './problemMatching';
import { Logger } from './logger';

export { ProblemMatchingPattern } from './problemMatching';

export interface FileDiagnostic {
    file: string;
    diagnostic: Diagnostic;
}

function toDiagnosticSeverity(severity: string): DiagnosticSeverity {
    return severity === 'error' ? DiagnosticSeverity.Error :
        (severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information);
}

function toFileDiagnostic(problem: MatchedProblem): FileDiagnostic {
    const range = new Range(
        new Position(problem.startLine, problem.startColumn),
        new Position(problem.endLine, problem.endColumn),
    );
    const diagnostic = new Diagnostic(range, problem.message, toDiagnosticSeverity(problem.severity));
    diagnostic.source = 'Ceedling';
    return { file: problem.file, diagnostic };
}

// Thin wrapper around problemMatching.ts's pure regex-matching and path-resolution logic. Holds
// the actual VS Code state - the Problems panel's DiagnosticCollection, and which diagnostics
// belong to which run - none of which the pure module touches.
export class ProblemMatcher {
    private suitsDiagnostics: Map<string, Array<FileDiagnostic>>;
    private readonly diagnosticCollection: DiagnosticCollection;

    constructor(private readonly logger: Logger) {
        this.suitsDiagnostics = new Map<string, Array<FileDiagnostic>>();
        this.diagnosticCollection = languages.createDiagnosticCollection('Ceedling');
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
        let normalizedPatterns: ProblemMatchingPattern[];
        if (mode === "patterns") {
            const { valid, invalid } = normalizePatterns(patterns);
            for (const droppedPattern of invalid) {
                this.logger.debug(`normalizePatterns: dropping malformed pattern (missing/wrong-typed regexp, message, or file): ${JSON.stringify(droppedPattern)}`);
            }
            normalizedPatterns = valid;
        } else {
            normalizedPatterns = getPatternsPreset(mode);
        }

        const allFileDiagnostics: FileDiagnostic[] = [];
        for (const pattern of normalizedPatterns) {
            try {
                const problems = getPatternProblems(stdout, stderr, projectPath, pattern);
                allFileDiagnostics.push(...problems.map(toFileDiagnostic));
            } catch (e) {
                this.logger.warn(`scan: pattern threw, likely an invalid regexp (${pattern.regexp}): ${e}`);
            }
        }

        this.logger.debug(`scan(id=${id}): mode=${mode}, patterns=${normalizedPatterns.length}, diagnostics=${allFileDiagnostics.length}`);
        this.suitsDiagnostics.set(id, allFileDiagnostics);
        this.updateDiagnosticsCollection();
        return allFileDiagnostics;
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
