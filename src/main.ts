import vscode from 'vscode';
import { CeedlingTestController } from './testController';
import { Logger } from './logger';

const logger = new Logger();
const controllers = new Map<vscode.WorkspaceFolder, CeedlingTestController>();
let isDevelopmentMode = false;

function addWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    logger.debug(`addWorkspaceFolder(${workspaceFolder.uri.toString()})`);
    controllers.set(workspaceFolder, new CeedlingTestController(workspaceFolder, logger, isDevelopmentMode));
}

function removeWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    logger.debug(`removeWorkspaceFolder(${workspaceFolder.uri.toString()})`);
    controllers.get(workspaceFolder)?.dispose();
    controllers.delete(workspaceFolder);
}

async function ceedlingClean(): Promise<void> {
    await Promise.all([...controllers.values()].map((controller) => controller.clean()));
}

async function ceedlingClobber(): Promise<void> {
    await Promise.all([...controllers.values()].map((controller) => controller.clobber()));
}

// A guard, not a real command. It is never listed in package.json's contributes.commands, so it
// never appears in the Command Palette. `${command:ceedlingExplorer.debugTestExecutable}` in a
// launch.json program string only ever gets substituted with a real path inside
// CeedlingTestController.handleDebug. handleDebug is only reached through the Testing view's own
// Debug icon. Starting that same launch config from F5 or the Run and Debug panel skips
// handleDebug entirely. VS Code then falls back to resolving the token as an ordinary registered
// command. Throwing here turns that mistake into a clear, actionable error. VS Code shows a
// thrown ${command:...} error directly and aborts the launch, rather than proceeding with a bare
// "...\null does not exist" dialog.
function debugTestExecutableGuard(): never {
    throw new Error("Start debugging from a test’s debug icon in the Testing view, not with F5 or via the Run and Debug panel.");
}

export async function activate(context: vscode.ExtensionContext) {
    isDevelopmentMode = context.extensionMode === vscode.ExtensionMode.Development;
    const workspaceFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    logger.debug(`activate(): isDevelopmentMode=${isDevelopmentMode}, workspaceFolders=${workspaceFolderCount}`);
    context.subscriptions.push(logger);
    context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clean", ceedlingClean));
    context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clobber", ceedlingClobber));
    context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.debugTestExecutable", debugTestExecutableGuard));

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
        addWorkspaceFolder(workspaceFolder);
    }
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const workspaceFolder of event.added) {
            addWorkspaceFolder(workspaceFolder);
        }
        for (const workspaceFolder of event.removed) {
            removeWorkspaceFolder(workspaceFolder);
        }
    }));
    context.subscriptions.push({ dispose: () => { for (const controller of controllers.values()) controller.dispose(); } });
}
