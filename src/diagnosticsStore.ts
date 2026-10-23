// The diagnostics each run reported, kept by id: a project, or one of its files. The Problems
// panel shows their union, by file, without duplicates, since a project run and a file run can
// report the same compiler error. It has no `vscode` dependency. ProblemMatcher publishes
// `byFile()` to a DiagnosticCollection.
export class DiagnosticsStore<D extends { file: string }> {
    private readonly entries = new Map<string, D[]>();

    constructor(private readonly same: (a: D, b: D) => boolean) { }

    set(id: string, diagnostics: D[]): void {
        this.entries.set(id, diagnostics);
    }

    // Keeps only the diagnostics under `id` that `keep` accepts. False when `id` has none.
    retain(id: string, keep: (diagnostic: D) => boolean): boolean {
        const current = this.entries.get(id);
        if (!current) {
            return false;
        }
        this.entries.set(id, current.filter(keep));
        return true;
    }

    // Keeps only the ids `keep` accepts, e.g. dropping a deleted test file's entry.
    retainIds(keep: (id: string) => boolean): void {
        for (const id of [...this.entries.keys()]) {
            if (!keep(id)) {
                this.entries.delete(id);
            }
        }
    }

    clear(): void {
        this.entries.clear();
    }

    byFile(): Map<string, D[]> {
        const byFile = new Map<string, D[]>();
        for (const diagnostics of this.entries.values()) {
            for (const diagnostic of diagnostics) {
                const shown = byFile.get(diagnostic.file) ?? [];
                if (!shown.some((existing) => this.same(existing, diagnostic))) {
                    shown.push(diagnostic);
                }
                byFile.set(diagnostic.file, shown);
            }
        }
        return byFile;
    }
}
