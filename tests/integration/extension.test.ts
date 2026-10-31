import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Logger } from '../../src/logger';
import type { CeedlingExplorerApi } from '../../src/main';

// Runs inside a real VS Code with the built extension loaded (see main.ts). It checks what unit
// tests can't: that the bundle loads, activates, and wires its commands into VS Code.

const EXTENSION_ID = 'throw-the-switch.vscode-ceedling';

suite('Extension in VS Code', function () {
    // Setup waits for discovery, which runs Node processes and outlasts mocha's default 2s.
    this.timeout(60000);
    suiteSetup(async () => {
        const api = await vscode.extensions.getExtension<CeedlingExplorerApi | undefined>(EXTENSION_ID)!.activate();
        // Clean acts on discovered projects, so discovery must have finished first.
        assert.ok(api, 'the extension returns its test API in test mode');
        await Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => api.controllerFor(folder.uri)?.whenDiscovered() ?? Promise.resolve()));
    });

    test('activates', () => {
        assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
    });

    test('registers its commands', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['ceedlingExplorer.clean', 'ceedlingExplorer.clobber', 'ceedlingExplorer.debugTestExecutable']) {
            assert.ok(commands.includes(command), `${command} is registered`);
        }
    });

    // VS Code disposes the extension's subscriptions in turn, and a controller logs as it goes.
    // A closed channel throws, which would stop that controller's disposal short.
    test('a disposed logger ignores further logging', async () => {
        const logger = new Logger('Ceedling Explorer (test)');
        logger.info('opened');
        // VS Code finishes setting a channel up asynchronously, and warns of one disposed first.
        await new Promise((resolve) => setTimeout(resolve, 500));
        logger.dispose();
        assert.doesNotThrow(() => { logger.trace('after'); logger.debug('after'); logger.info('after'); logger.warn('after'); logger.error('after'); });
    });

    // A launch configuration started outside the Testing view resolves this token itself.
    test('the debug executable token refuses to resolve outside the Testing view', async () => {
        await assert.rejects(Promise.resolve(vscode.commands.executeCommand('ceedlingExplorer.debugTestExecutable')), /Testing view/);
    });

    test('Clean runs in each folder with a Ceedling project, and only there', async () => {
        await vscode.commands.executeCommand('ceedlingExplorer.clean');
        const log = (name: string) => {
            const folder = vscode.workspace.workspaceFolders?.find((f) => f.name === name);
            assert.ok(folder, name);
            const file = vscode.Uri.joinPath(folder.uri, 'fake-ceedling.log').fsPath;
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        };
        assert.ok(log('fake-project').split('\n').some((line) => line.startsWith('["clean"')));
        assert.strictEqual(log('without-project'), '');
    });
});
