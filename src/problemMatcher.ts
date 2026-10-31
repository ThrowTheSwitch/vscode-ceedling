import {
    Diagnostic,
    type DiagnosticCollection,
    DiagnosticSeverity,
    languages,
    Position,
    Range,
    Uri,
} from 'vscode';
import { type DiagnosticsSink, DiagnosticsStore } from './diagnosticsStore';
import { type MatchedProblem, sameProblem } from './problemMatching';

function toDiagnosticSeverity(severity: string): DiagnosticSeverity {
    return severity === 'error' ? DiagnosticSeverity.Error :
        (severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information);
}

function toDiagnostic(problem: MatchedProblem): Diagnostic {
    const range = new Range(
        new Position(problem.startLine, problem.startColumn),
        new Position(problem.endLine, problem.endColumn),
    );
    const diagnostic = new Diagnostic(range, problem.message, toDiagnosticSeverity(problem.severity));
    diagnostic.source = 'Ceedling';
    return diagnostic;
}

// The Problems panel side of problem matching. Pattern matching itself lives in the pure
// problemMatching.ts, and each id's problems in DiagnosticsStore. An id is whatever a run keys its
// problems under, a project or one of its files. This class publishes the store to the
// DiagnosticCollection after every change.
export class ProblemMatcher implements DiagnosticsSink {
    private readonly store = new DiagnosticsStore<MatchedProblem>(sameProblem);
    private readonly diagnosticCollection: DiagnosticCollection = languages.createDiagnosticCollection('Ceedling');

    set(id: string, problems: MatchedProblem[]): void {
        this.store.set(id, problems);
        this.publish();
    }

    retain(id: string, keep: (problem: MatchedProblem) => boolean): void {
        if (this.store.retain(id, keep)) {
            this.publish();
        }
    }

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
        for (const [file, problems] of this.store.byFile()) {
            this.diagnosticCollection.set(Uri.file(file), problems.map(toDiagnostic));
        }
    }
}
