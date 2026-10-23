import {
    Diagnostic,
    type DiagnosticCollection,
    DiagnosticSeverity,
    Position,
    Range,
    Uri,
    languages
} from 'vscode';
import {
    getPatternProblems,
    getPatternsPreset,
    type MatchedProblem,
    normalizePatterns,
    type ProblemMatchingPattern,
} from './problemMatching';
import util from 'util';
import { DiagnosticsStore } from './diagnosticsStore';
import { type Logger } from './logger';

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
// problemMatching.ts, and each id's diagnostics in DiagnosticsStore. An id is whatever a run keys
// its diagnostics under, a project or one of its files. This class publishes the store to the
// DiagnosticCollection after every change.
export class ProblemMatcher {
    private readonly store = new DiagnosticsStore<FileDiagnostic>((a, b) => sameDiagnostic(a.diagnostic, b.diagnostic));
    private readonly diagnosticCollection: DiagnosticCollection;

    constructor(private readonly logger: Logger) {
        this.diagnosticCollection = languages.createDiagnosticCollection('Ceedling');
    }

    // Every problem the configured patterns find in a run's output. No state changes.
    match(stdout: string, stderr: string, projectPath: string, mode: string, patterns: readonly unknown[]): FileDiagnostic[] {
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
                this.logger.warn(`match: pattern threw, likely an invalid regexp (${pattern.regexp}): ${util.format(e)}`);
            }
        }
        this.logger.debug(`match: mode=${mode}, patterns=${normalizedPatterns.length}, diagnostics=${fileDiagnostics.length}`);
        return fileDiagnostics;
    }

    set(id: string, diagnostics: FileDiagnostic[]): void {
        this.store.set(id, diagnostics);
        this.publish();
    }

    // Keeps only the diagnostics under `id` that `keep` accepts.
    retain(id: string, keep: (diagnostic: FileDiagnostic) => boolean): void {
        if (this.store.retain(id, keep)) {
            this.publish();
        }
    }

    // Keeps only the ids `keep` accepts, e.g. dropping a deleted test file's entry.
    retainIds(keep: (id: string) => boolean): void {
        this.store.retainIds(keep);
        this.publish();
    }

    clear(): void {
        this.store.clear();
        this.diagnosticCollection.clear();
    }

    dispose(): void {
        this.clear();
        this.diagnosticCollection.dispose();
    }

    private publish(): void {
        this.diagnosticCollection.clear();
        for (const [file, diagnostics] of this.store.byFile()) {
            this.diagnosticCollection.set(Uri.file(file), diagnostics.map((d) => d.diagnostic));
        }
    }
}

function sameDiagnostic(a: Diagnostic, b: Diagnostic): boolean {
    return a.message === b.message && a.severity === b.severity && a.source === b.source && a.range.isEqual(b.range);
}
