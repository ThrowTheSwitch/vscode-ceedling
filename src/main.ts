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

export async function activate(context: vscode.ExtensionContext) {
    isDevelopmentMode = context.extensionMode === vscode.ExtensionMode.Development;
    const workspaceFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    logger.debug(`activate(): isDevelopmentMode=${isDevelopmentMode}, workspaceFolders=${workspaceFolderCount}`);
    context.subscriptions.push(logger);
    context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clean", ceedlingClean));
    context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clobber", ceedlingClobber));

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
