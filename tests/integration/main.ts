import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a downloaded VS Code with this extension under development, opened on a fixture
// workspace, and runs the integration suite inside it. Other installed extensions are disabled
// so they can't interfere.
async function main() {
    try {
        // __dirname is out/tests/integration once compiled.
        const repoRoot = path.resolve(__dirname, '../../../');
        await runTests({
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath: path.resolve(__dirname, './runner'),
            launchArgs: [path.resolve(repoRoot, 'tests/fixtures/workspace-without-project'), '--disable-extensions'],
        });
    } catch (err) {
        console.error(err);
        console.error('Failed to run tests');
        process.exit(1);
    }
}

void main();
