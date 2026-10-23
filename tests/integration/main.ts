import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a downloaded VS Code with this extension under development and runs the integration
// suite inside it. Other installed extensions are disabled so they can't interfere. The workspace
// has two folders: one without a Ceedling project, and a copy of the fake Ceedling project, whose
// `ceedlingExplorer.ceedlingCommand` runs tests/fixtures/fake-ceedling/ceedling.js. Its builds
// write into the temporary copy, never into the repository.
async function main() {
    // __dirname is out-test/tests/integration once compiled.
    const repoRoot = path.resolve(__dirname, '../../../');
    const fixtures = path.join(repoRoot, 'tests', 'fixtures');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceedling-integration-'));
    try {
        const project = path.join(workspaceRoot, 'fake-project');
        fs.cpSync(path.join(fixtures, 'workspace-fake-ceedling'), project, { recursive: true });
        fs.mkdirSync(path.join(project, '.vscode'));
        fs.writeFileSync(path.join(project, '.vscode', 'settings.json'), JSON.stringify({
            'ceedlingExplorer.ceedlingCommand': `node "${path.join(fixtures, 'fake-ceedling', 'ceedling.js')}"`,
            'ceedlingExplorer.problemMatching': { mode: 'gcc' },
        }, null, 4));
        const workspaceFile = path.join(workspaceRoot, 'integration.code-workspace');
        fs.writeFileSync(workspaceFile, JSON.stringify({
            folders: [
                { name: 'without-project', path: path.join(fixtures, 'workspace-without-project') },
                { name: 'fake-project', path: project },
            ],
        }, null, 4));
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
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
}

void main();
