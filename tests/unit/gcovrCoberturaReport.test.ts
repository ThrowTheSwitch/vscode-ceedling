import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// Namespace import, not a default import: test.tsconfig.json has no esModuleInterop (unlike the
// root tsconfig.json, which production code relies on for `import xml2js from 'xml2js'`), and
// @types/xml2js has no default export - only this form type-checks here.
import * as xml2js from 'xml2js';
import { getCoverageFromCoberturaReport, CoveredFile } from '../../src/gcovrCoberturaReport';

// __dirname at runtime is out/tests/unit (tsc mirrors the source tree under outDir); fixtures are
// plain data files tsc doesn't copy into out/, so walk back up to the repo root to find them.
const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function parseFixture(...segments: string[]): Promise<any> {
    const data = fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
    const parser = new xml2js.Parser({ explicitArray: false });
    return new Promise((resolve, reject) => {
        parser.parseString(data, (error: any, result: any) => error ? reject(error) : resolve(result));
    });
}

// Both fixtures are one probe project's reports from Ceedling's gcov plugin, run in projectDir:
// src/Calculator.c lies inside gcovr's root, ../lib/Clamp.c above it, as sources often do.
const projectDir = path.resolve('/home/dev/gcovr_probe/project');
const insideRoot = path.resolve(projectDir, 'src', 'Calculator.c');
const outsideRoot = path.resolve('/home/dev/gcovr_probe/lib/Clamp.c');

function byPath(files: CoveredFile[], filePath: string): CoveredFile {
    const found = files.find(file => file.path === filePath);
    assert.ok(found, `expected a coverage entry for ${filePath}, got ${files.map(file => file.path)}`);
    return found;
}

for (const version of ['gcovr-5.0', 'gcovr-8.6']) {
    suite(`getCoverageFromCoberturaReport (${version}, mixed relative/absolute paths)`, () => {
        let files: CoveredFile[];
        suiteSetup(async () => {
            files = getCoverageFromCoberturaReport(await parseFixture(version, 'cobertura-mixed-paths.xml'), projectDir);
        });

        test('reports every class in the report', () => {
            assert.strictEqual(files.length, 2);
        });

        test('resolves a file inside the gcovr root to an absolute path', () => {
            byPath(files, insideRoot);
        });

        test('keeps a file outside the gcovr root at its absolute path', () => {
            byPath(files, outsideRoot);
        });

        test('carries per-line hit counts, including never-executed lines', () => {
            const lines = byPath(files, outsideRoot).lines;
            assert.deepStrictEqual(lines.map(line => [line.line, line.hits]), [[3, 1], [4, 1], [5, 0], [7, 1]]);
        });

        test('expands condition-coverage into one entry per branch outcome', () => {
            const branches = byPath(files, outsideRoot).lines.find(line => line.line === 4)!.branches;
            assert.deepStrictEqual(branches, [true, false]);
        });

        test('leaves a plain statement without branches', () => {
            assert.deepStrictEqual(byPath(files, outsideRoot).lines.find(line => line.line === 3)!.branches, []);
        });
    });
}

suite('getCoverageFromCoberturaReport (function entries)', () => {
    test('gcovr 5.0 writes an empty <methods/>, so there are none', async () => {
        const files = getCoverageFromCoberturaReport(await parseFixture('gcovr-5.0', 'cobertura-mixed-paths.xml'), projectDir);
        assert.deepStrictEqual(files.map(file => file.functions), [[], []]);
    });

    test('gcovr 8.6 fills them in; a function takes its hit count from its first line', async () => {
        const files = getCoverageFromCoberturaReport(await parseFixture('gcovr-8.6', 'cobertura-mixed-paths.xml'), projectDir);
        assert.deepStrictEqual(byPath(files, outsideRoot).functions, [{ name: 'clamp_positive', line: 3, hits: 1 }]);
        assert.deepStrictEqual(byPath(files, insideRoot).functions, [{ name: 'add', line: 3, hits: 1 }]);
    });
});

suite('getCoverageFromCoberturaReport (degenerate reports)', () => {
    test('returns nothing for a report with no packages', () => {
        assert.deepStrictEqual(getCoverageFromCoberturaReport({ coverage: { sources: { source: '.' }, packages: '' } }, projectDir), []);
    });

    test('skips a class that has no filename', () => {
        const report = { coverage: { packages: { package: { classes: { class: { $: {} } } } } } };
        assert.deepStrictEqual(getCoverageFromCoberturaReport(report, projectDir), []);
    });
});
