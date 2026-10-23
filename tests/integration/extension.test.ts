import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';

// Runs inside a real VS Code with the built extension loaded (see main.ts). It checks what unit
// tests can't: that the bundle loads, activates, and wires its commands into VS Code.

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

    // The folder without a project has nothing to clean, and runs no Ceedling.
    test('Clean runs in each folder with a Ceedling project', async () => {
        await vscode.commands.executeCommand('ceedlingExplorer.clean');
        const project = vscode.workspace.workspaceFolders?.find((f) => f.name === 'fake-project');
        assert.ok(project);
        const log = fs.readFileSync(vscode.Uri.joinPath(project.uri, 'fake-ceedling.log').fsPath, 'utf8');
        assert.ok(log.split('\n').some((line) => line.startsWith('["clean"')));
    });
});
