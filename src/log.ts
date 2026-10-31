// What the core logs through. The adapter's Logger writes to VS Code's log channel and shows its
// notifications. Tests record each call. It has no `vscode` dependency.
export interface Log {
    trace(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    // Logs, then notifies the user.
    showWarning(...args: unknown[]): void;
    showError(...args: unknown[]): void;
}
