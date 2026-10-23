import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a downloaded VS Code with this extension under development and runs the integration
// suite inside it. Other installed extensions are disabled so they can't interfere. The workspace
// holds temporary copies of two fixture folders, one without a Ceedling project and the fake
// Ceedling project. Each folder's `ceedlingExplorer.ceedlingCommand` runs
// tests/fixtures/fake-ceedling/ceedling.js, so builds never write into the repository.
async function main() {
    // __dirname is out-test/tests/integration once compiled.
    const repoRoot = path.resolve(__dirname, '../../../');
    const fixtures = path.join(repoRoot, 'tests', 'fixtures');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceedling-integration-'));
    try {
        // Both folders run the fake, so a Ceedling call in the folder without a project leaves a log.
        const folders = [['without-project', 'workspace-without-project'], ['fake-project', 'workspace-fake-ceedling']].map(([name, fixture]) => {
            const folder = path.join(workspaceRoot, name);
            fs.cpSync(path.join(fixtures, fixture), folder, { recursive: true });
            fs.mkdirSync(path.join(folder, '.vscode'));
            fs.writeFileSync(path.join(folder, '.vscode', 'settings.json'), JSON.stringify({
                'ceedlingExplorer.ceedlingCommand': `node "${path.join(fixtures, 'fake-ceedling', 'ceedling.js')}"`,
                'ceedlingExplorer.problemMatching': { mode: 'gcc' },
            }, null, 4));
            return { name, path: folder };
        });
        const workspaceFile = path.join(workspaceRoot, 'integration.code-workspace');
        fs.writeFileSync(workspaceFile, JSON.stringify({ folders }, null, 4));
        await runTests({
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath: path.resolve(__dirname, './runner'),
            launchArgs: [workspaceFile, '--disable-extensions'],
        });
    } catch (err) {
        console.error(err);
        console.error('Failed to run tests');
        process.exitCode = 1;
    } finally {
        // VS Code's helper processes may hold the folder briefly after it exits, on Windows especially.
        try {
            fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (err) {
            console.warn(`Could not remove ${workspaceRoot}: ${String(err)}`);
        }
    }
}

void main();
