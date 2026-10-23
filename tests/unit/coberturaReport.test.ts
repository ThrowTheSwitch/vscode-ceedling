import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
// Namespace import, not a default import: test.tsconfig.json has no esModuleInterop (unlike the
// root tsconfig.json, which production code relies on for `import xml2js from 'xml2js'`), and
// @types/xml2js has no default export - only this form type-checks here.
import * as xml2js from 'xml2js';
import { type CoveredFile, mergeCoverage, parseCoberturaReport, readCoberturaReport, reportedFiles } from '../../src/coberturaReport';

// Each file at its first candidate path, which is its only one in these single-source reports.
function getCoverageFromCoberturaReport(xmlReportData: unknown, baseDir: string): CoveredFile[] {
    return reportedFiles(readCoberturaReport(xmlReportData), baseDir, path)
        .map(({ candidates, lines, functions }) => ({ path: candidates[0], lines, functions }));
}

// __dirname at runtime is out/tests/unit (tsc mirrors the source tree under outDir); fixtures are
// plain data files tsc doesn't copy into out/, so walk back up to the repo root to find them.
const fixturesRoot = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

function parseFixture(...segments: string[]): Promise<any> {
    const data = fs.readFileSync(path.resolve(fixturesRoot, ...segments), 'utf8');
    const parser = new xml2js.Parser({ explicitArray: false });
    return new Promise((resolve, reject) => {
        parser.parseString(data, (error: any, result: any) => error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(result));
    });
}

// Both fixtures are one probe project's reports from Ceedling's gcov plugin, run in projectDir:
// src/Calculator.c lies inside gcovr's root, ../lib/Clamp.c above it, as sources often do.
const projectDir = path.resolve('/home/dev/gcovr_probe/project');
const insideRoot = path.resolve(projectDir, 'src', 'Calculator.c');
const outsideRoot = path.resolve('/home/dev/gcovr_probe/lib/Clamp.c');

function byPath(files: CoveredFile[], filePath: string): CoveredFile {
    const found = files.find(file => file.path === filePath);
    assert.ok(found, `expected a coverage entry for ${filePath}, got ${files.map(file => file.path).join(', ')}`);
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

suite('parseCoberturaReport', () => {
    test('rejects malformed or truncated XML', async () => {
        await assert.rejects(parseCoberturaReport('<coverage><packages>'));
    });

    test('rejects a document that is not a Cobertura report', async () => {
        await assert.rejects(parseCoberturaReport('<TestRun/>'), /<coverage>/);
    });
});

// A Cobertura <filename> is relative to one of the report's <source> roots, or absolute. Which
// source isn't recorded, so each gives a candidate, in the report's order.
suite('reportedFiles', () => {
    const report = (sources: string[], filename: string) => ({ sources, files: [{ filename, lines: [], functions: [] }] });
    const candidates = (r: ReturnType<typeof report>, baseDir: string, rules = path.posix) => reportedFiles(r, baseDir, rules)[0].candidates;

    test('a relative filename has one candidate per source, each resolved against the directory the tool ran in', () => {
        assert.deepStrictEqual(candidates(report(['.', 'src', '../lib'], './src/Calculator.c'), '/p/project'),
            ['/p/project/src/Calculator.c', '/p/project/src/src/Calculator.c', '/p/lib/src/Calculator.c']);
    });

    test('an absolute filename is its only candidate', () => {
        assert.deepStrictEqual(candidates(report(['.', 'src'], '/p/lib/Clamp.c'), '/p/project'), ['/p/lib/Clamp.c']);
    });

    test('an absolute source stands on its own', () => {
        assert.deepStrictEqual(candidates(report(['/p/project'], 'src/a.c'), '/elsewhere'), ['/p/project/src/a.c']);
    });

    test('with no sources, a relative filename resolves against the directory the tool ran in', () => {
        assert.deepStrictEqual(candidates(report([], 'src/a.c'), '/p/project'), ['/p/project/src/a.c']);
    });

    test('duplicate candidates appear once', () => {
        assert.deepStrictEqual(candidates(report(['.', './'], 'a.c'), '/p'), ['/p/a.c']);
    });

    test('Windows paths follow Windows rules', () => {
        assert.deepStrictEqual(candidates(report(['.'], 'src\\a.c'), 'C:\\ws\\fw', path.win32), ['C:\\ws\\fw\\src\\a.c']);
        assert.deepStrictEqual(candidates(report(['.'], 'D:/lib/b.c'), 'C:\\ws\\fw', path.win32), ['D:\\lib\\b.c']);
    });
});

// A request's coverage runs leave one report per build directory. Each report already counts the
// counters every earlier build of the request left there, so the last one read supersedes the rest.
suite('mergeCoverage', () => {
    const file = (filePath: string, lines: Array<[number, number, boolean[]?]>, functions: Array<[string, number, number]> = []): CoveredFile =>
        ({ path: filePath, lines: lines.map(([line, hits, branches = []]) => ({ line, hits, branches })), functions: functions.map(([name, line, hits]) => ({ name, line, hits })) });
    const exact = (p: string) => p;

    test("a later report at the same path replaces an earlier one", () => {
        const merged = mergeCoverage([
            { path: '/p/build/report.xml', files: [file('/p/a.c', [[1, 1]]), file('/p/b.c', [[1, 1]])] },
            { path: '/p/build/report.xml', files: [file('/p/a.c', [[1, 3]])] },
        ], exact);
        assert.deepStrictEqual(merged, [file('/p/a.c', [[1, 3]])]);
    });

    test('reports at different paths add up per file: hits, taken branches, and function hits', () => {
        const merged = mergeCoverage([
            { path: '/p/build/report.xml', files: [file('/lib/c.c', [[1, 1, [true, false]], [2, 0]], [['f', 1, 1]])] },
            { path: '/q/build/report.xml', files: [file('/lib/c.c', [[1, 2, [false, true]], [3, 1]], [['f', 1, 2]]), file('/q/d.c', [[1, 1]])] },
        ], exact);
        assert.deepStrictEqual(merged, [
            file('/lib/c.c', [[1, 3, [true, true]], [2, 0], [3, 1]], [['f', 1, 3]]),
            file('/q/d.c', [[1, 1]]),
        ]);
    });

    test('paths are compared through the given key, e.g. ignoring case on Windows', () => {
        const merged = mergeCoverage([
            { path: 'C:\\p\\report.xml', files: [file('C:\\lib\\c.c', [[1, 1]])] },
            { path: 'c:\\P\\REPORT.xml', files: [file('c:\\lib\\c.c', [[1, 5]])] },
        ], (p) => p.toLowerCase());
        assert.deepStrictEqual(merged, [file('c:\\lib\\c.c', [[1, 5]])]);
    });

    test('no reports, no coverage', () => {
        assert.deepStrictEqual(mergeCoverage([], exact), []);
    });
});

// Ceedling 1.2.0's gcov plugin, run by tests/fixtures/capture/capture-gcov.sh in /probe/project,
// with src/Calculator.c inside the project and ../lib/Clamp.c above it.
suite('readCoberturaReport (ReportGenerator 5.5.11)', () => {
    const probe = path.posix.resolve('/probe/project');
    let report: Awaited<ReturnType<typeof parseCoberturaReport>>;
    suiteSetup(async () => {
        report = await parseCoberturaReport(fs.readFileSync(path.resolve(fixturesRoot, 'reportgenerator-5.5.11', 'cobertura-probe.xml'), 'utf8'));
    });

    // ReportGenerator lists every source directory Ceedling gave it, and names files relative to
    // the directory it ran in. The engine keeps whichever candidate exists.
    test('each file has a candidate for every source, the one that exists first', () => {
        assert.deepStrictEqual(report.sources, ['.', 'src', '../lib']);
        assert.deepStrictEqual(reportedFiles(report, probe, path.posix).map((f) => f.candidates), [
            ['/probe/lib/Clamp.c', '/probe/project/lib/Clamp.c'],
            ['/probe/project/src/Calculator.c', '/probe/project/src/src/Calculator.c', '/probe/lib/src/Calculator.c'],
        ]);
    });

    test('carries line hits and partly taken branches', () => {
        const clamp = report.files[0];
        assert.deepStrictEqual(clamp.lines.map((l) => [l.line, l.hits, l.branches]), [
            [3, 1, []], [5, 1, [true, false]], [6, 1, []], [7, 0, [false, false]], [8, 0, []], [9, 0, []],
        ]);
    });

    test('reads each function from its <method>, its hits from its first line', () => {
        assert.deepStrictEqual(report.files.map((f) => f.functions), [
            [{ name: 'clamp', line: 3, hits: 1 }],
            [{ name: 'add', line: 3, hits: 1 }, { name: 'subtract', line: 8, hits: 0 }],
        ]);
    });
});

suite('readCoberturaReport (gcovr 7.2)', () => {
    // With the plugin's default :report_root: ".", gcovr 7.2 leaves out ../lib/Clamp.c entirely.
    test('reports only sources within its root, without functions', async () => {
        const report = await parseCoberturaReport(fs.readFileSync(path.resolve(fixturesRoot, 'gcovr-7.2', 'cobertura-probe.xml'), 'utf8'));
        assert.deepStrictEqual(reportedFiles(report, '/probe/project', path.posix).map((f) => [f.candidates, f.lines.map((l) => [l.line, l.hits]), f.functions]),
            [[['/probe/project/src/Calculator.c'], [[3, 1], [5, 1], [8, 0], [10, 0]], []]]);
    });
});
