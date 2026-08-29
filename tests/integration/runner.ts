import * as path from 'path';
// Default imports, not `import * as X`: TypeScript 6 (see package.json's `typescript`
// devDependency) rejects calling/constructing a namespace import even with esModuleInterop on.
import Mocha from 'mocha';
import glob from 'glob';

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    // Scoped to this directory only (not '..' -> out/tests), so the tests/unit/*.test.js files
    // aren't also picked up and re-run inside this slower Electron-hosted suite - they have their
    // own fast, VS-Code-host-free runner (see the "test:unit" npm script).
    const testsRoot = path.resolve(__dirname);

    return new Promise((c, e) => {
        glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
            if (err) {
                return e(err);
            }

            // Add files to the test suite
            files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

            try {
                // Run the mocha test
                mocha.run(failures => {
                    if (failures > 0) {
                        e(new Error(`${failures} tests failed.`));
                    } else {
                        c();
                    }
                });
            } catch (err) {
                e(err);
            }
        });
    });
}
