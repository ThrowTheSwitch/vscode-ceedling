import util from 'util';
import vscode from 'vscode';
import { LogLevel, type LogOutputChannel } from 'vscode';

// Writes to the "Ceedling Explorer" log output channel, created on first use. Its level follows
// VS Code's own log level setting for the channel. Once disposed it logs nothing: a closed channel
// throws, and controllers still log while VS Code disposes them.
export class Logger {
    private _channel?: LogOutputChannel
    private disposed = false;

    // VS Code keys a channel by extension and name, so another name is another channel.
    constructor(private readonly name = "Ceedling Explorer") { }

    private get channel(): LogOutputChannel | undefined {
        if (this.disposed) return undefined
        if (this._channel) return this._channel
        this._channel = vscode.window.createOutputChannel(this.name, { log: true });
        this._channel.onDidChangeLogLevel((level) => { this._channel?.info(`Log level: ${LogLevel[level]}`) });
        this._channel.info(`Log level: ${LogLevel[this._channel.logLevel]}`);
        return this._channel;
    }

    public trace(...args: unknown[]) {
        this.channel?.trace(this.format(...args));
    }

    public debug(...args: unknown[]) {
        this.channel?.debug(this.format(...args));
    }

    public info(...args: unknown[]) {
        this.channel?.info(this.format(...args));
    }

    public warn(...args: unknown[]) {
        this.channel?.warn(this.format(...args));
    }

    public error(...args: unknown[]) {
        this.channel?.error(this.format(...args));
    }

    public showWarning(...args: unknown[]) {
        const message = this.format(...args);
        this.warn(message);
        vscode.window.showWarningMessage(message);
    }

    // Logs, notifies, and reveals the log without taking focus, for errors the user must act on.
    public showError(...args: unknown[]) {
        const message = this.format(...args);
        this.error(message);
        this.channel?.show(true);
        vscode.window.showErrorMessage(message);
    }

    private format(...args: unknown[]): string {
        return util.format(...args as [unknown, unknown[]]);
    }

    dispose(): void {
        this.disposed = true;
        this._channel?.dispose();
    }
}