import * as assert from 'assert';
import * as vscode from 'vscode';

// Runs inside a real VS Code with the built extension loaded (see main.ts), on a workspace with
// no Ceedling project. It checks what unit tests can't: that the bundle loads, activates, and
// wires its commands into VS Code.

const EXTENSION_ID = 'throw-the-switch.vscode-ceedling';

suite('Extension in VS Code', () => {
    suiteSetup(async () => {
        await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
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

    // A launch configuration started outside the Testing view resolves this token itself.
    test('the debug executable token refuses to resolve outside the Testing view', async () => {
        await assert.rejects(Promise.resolve(vscode.commands.executeCommand('ceedlingExplorer.debugTestExecutable')), /Testing view/);
    });

    // Without a project, there is nothing to clean and no Ceedling to run.
    test('Clean succeeds in a workspace without a Ceedling project', async () => {
        await vscode.commands.executeCommand('ceedlingExplorer.clean');
    });
});
