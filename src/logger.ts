import util from 'util';
import vscode from 'vscode';
import { LogLevel, type LogOutputChannel } from 'vscode';

// Writes to the "Ceedling Explorer" log output channel, created on first use. Its level follows
// VS Code's own log level setting for the channel.
export class Logger {
    private _channel?: LogOutputChannel

    private get channel(): LogOutputChannel {
        if (this._channel) return this._channel
        this._channel = vscode.window.createOutputChannel("Ceedling Explorer", { log: true });
        this._channel.onDidChangeLogLevel((level) => { this._channel?.info(`Log level: ${LogLevel[level]}`) });
        this._channel.info(`Log level: ${LogLevel[this._channel.logLevel]}`);
        return this._channel;
    }

    public trace(...args: unknown[]) {
        const message = this.format(...args);
        this.channel.trace(message);
    }

    public debug(...args: unknown[]) {
        const message = this.format(...args);
        this.channel.debug(message);
    }

    public info(...args: unknown[]) {
        const message = this.format(...args);
        this.channel.info(message);
    }

    public warn(...args: unknown[]) {
        const message = this.format(...args);
        this.channel.warn(message);
    }

    public error(...args: unknown[]) {
        const message = this.format(...args);
        this.channel.error(message);
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
        this.channel.show(true);
        vscode.window.showErrorMessage(message);
    }

    private format(...args: unknown[]): string {
        return util.format(...args as [unknown, unknown[]]);
    }

    dispose(): void {
        this._channel?.dispose();
    }
}