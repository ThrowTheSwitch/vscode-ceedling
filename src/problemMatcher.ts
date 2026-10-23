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

// A Diagnostic with the absolute path of the file it belongs to.
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

// The Problems panel side of problem matching. Pattern matching itself lives in the pure
// problemMatching.ts. This class holds the vscode state: the DiagnosticCollection, and each id's
// diagnostics. An id is whatever a run keys its diagnostics under, a project or one of its files.
// The panel shows the union of every id's diagnostics, without duplicates.
export class ProblemMatcher {
    private readonly entries = new Map<string, FileDiagnostic[]>();
    private readonly diagnosticCollection: DiagnosticCollection;

    constructor(private readonly logger: Logger) {
        this.diagnosticCollection = languages.createDiagnosticCollection('Ceedling');
    }

    // Every problem the configured patterns find in a run's output. No state changes.
    match(stdout: string, stderr: string, projectPath: string, mode: string, patterns: ProblemMatchingPattern[]): FileDiagnostic[] {
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

        const fileDiagnostics: FileDiagnostic[] = [];
        for (const pattern of normalizedPatterns) {
            try {
                fileDiagnostics.push(...getPatternProblems(stdout, stderr, projectPath, pattern).map(toFileDiagnostic));
            } catch (e) {
                this.logger.warn(`match: pattern threw, likely an invalid regexp (${pattern.regexp}): ${e}`);
            }
        }
        this.logger.debug(`match: mode=${mode}, patterns=${normalizedPatterns.length}, diagnostics=${fileDiagnostics.length}`);
        return fileDiagnostics;
    }

    set(id: string, diagnostics: FileDiagnostic[]): void {
        this.entries.set(id, diagnostics);
        this.publish();
    }

    // Keeps only the diagnostics under `id` that `keep` accepts.
    retain(id: string, keep: (diagnostic: FileDiagnostic) => boolean): void {
        const current = this.entries.get(id);
        if (current) {
            this.entries.set(id, current.filter(keep));
            this.publish();
        }
    }

    // Keeps only the ids `keep` accepts, e.g. dropping a deleted test file's entry.
    retainIds(keep: (id: string) => boolean): void {
        for (const id of [...this.entries.keys()]) {
            if (!keep(id)) {
                this.entries.delete(id);
            }
        }
        this.publish();
    }

    clear(): void {
        this.entries.clear();
        this.diagnosticCollection.clear();
    }

    dispose(): void {
        this.clear();
        this.diagnosticCollection.dispose();
    }

    private publish(): void {
        const byFile = new Map<string, Diagnostic[]>();
        for (const fileDiagnostics of this.entries.values()) {
            for (const { file, diagnostic } of fileDiagnostics) {
                const diagnostics = byFile.get(file) ?? [];
                if (!diagnostics.some((existing) => sameDiagnostic(existing, diagnostic))) {
                    diagnostics.push(diagnostic);
                }
                byFile.set(file, diagnostics);
            }
        }
        this.diagnosticCollection.clear();
        for (const [file, diagnostics] of byFile) {
            this.diagnosticCollection.set(Uri.file(file), diagnostics);
        }
    }
}

function sameDiagnostic(a: Diagnostic, b: Diagnostic): boolean {
    return a.message === b.message && a.severity === b.severity && a.source === b.source && a.range.isEqual(b.range);
}
