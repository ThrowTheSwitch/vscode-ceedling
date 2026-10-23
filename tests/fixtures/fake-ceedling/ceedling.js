#!/usr/bin/env node
// A stand-in for `ceedling` in the integration tests, run as `node ceedling.js <args>` from a
// project directory. It answers the commands the extension runs the way Ceedling 1.2.0 does, from
// the project's `fake-ceedling.json` scenario:
//
//   { "version": "1.2.0",
//     "files": { "test/test_x.c": { "results": { "test_a": "pass", "test_b": { "fail": "Expected 1 Was 2", "line": 9 },
//                                                "test_c": "ignore", "test_p(1)": "pass" } },
//                "test/test_y.c": { "compileError": "ceedling-1.0.0/compile-failure-stderr.txt" },
//                "test/test_z.c": { "hang": true } },
//     "gcov": { "utilities": ["gcovr"], "reports": ["Cobertura"], "reportTask": false,
//               "coverage": { "test/test_x.c": { "src/x.c": { "lines": [[1, 3], [2, 0], [4, 1, "50% (1/2)"]], "functions": [["f", 1, 3]] } } } } }
//
// A result left out of `results` goes unreported, as when discovery and Ceedling disagree on a
// name. `compileError` names a captured compiler failure under tests/fixtures. `hang` runs until
// the process is killed. Reports follow the structure of the captured CppUnit reports. Every
// invocation's arguments are appended to `fake-ceedling.log` as a JSON line.
//
// `gcov` enables the gcov plugin. Its `gcov:` tasks run tests as `test:` tasks do, and write a gcovr
// Cobertura report of each run test file's `coverage`, unless `reportTask` defers that to a
// `report:gcov` task on the same command line. A line is [number, hits] or [number, hits,
// "condition-coverage"], e.g. "50% (1/2)", for a branch line.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const cwd = process.cwd();
fs.appendFileSync(path.join(cwd, 'fake-ceedling.log'), `${JSON.stringify(args)}\n`);
const scenario = JSON.parse(fs.readFileSync(path.join(cwd, 'fake-ceedling.json'), 'utf8'));

const task = args[0] ?? '';
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mixins = args.flatMap((a, i) => args[i - 1] === '--mixin' ? [a] : []);
const buildRoot = path.join(cwd, 'build');

if (task === 'version') {
    process.stdout.write(`Welcome to Ceedling!\n  Ceedling => ${scenario.version}\n      CMock => 2.6.0\n      Unity => 2.7.2\n`);
} else if (task === 'dumpconfig' && args[1] === '--stdout') {
    // The extension's bundled mixin is what enables the report plugin, as with real Ceedling.
    const reporting = mixins.some((m) => /report-tests-log-factory\.yml$/.test(m));
    process.stdout.write('Loaded project configuration from command line argument.\n---\n' +
        `:project:\n  :build_root: build\n:plugins:\n  :enabled:\n${reporting ? '  - report_tests_log_factory\n' : ''}${scenario.gcov ? '  - gcov\n' : ''}` +
        ':unity:\n  :use_param_tests: true\n' + (scenario.gcov ? gcovConfig(scenario.gcov) : ''));
} else if (task === 'files:test') {
    process.stdout.write(`Test files:\n${testFiles().map((f) => ` - ${f}`).join('\n')}\n`);
} else if (task.startsWith('test:')) {
    test(task.slice('test:'.length), 'test');
} else if (task.startsWith('gcov:') && scenario.gcov) {
    gcov(task.slice('gcov:'.length));
} else if (task === 'clean' || task === 'clobber') {
    fs.rmSync(buildRoot, { recursive: true, force: true });
} else {
    process.stderr.write(`fake ceedling: unsupported command: ${args.join(' ')}\n`);
    process.exitCode = 1;
}

// Every test file under test/, as `ceedling files:test` lists them, project-relative.
function testFiles() {
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })) {
            const relative = `${dir}/${entry.name}`;
            if (entry.isDirectory()) walk(relative);
            else if (/^test_.*\.c$/.test(entry.name)) found.push(relative);
        }
    };
    walk('test');
    return found.sort();
}

// The plugin's merged defaults, as dumpconfig shows them.
function gcovConfig(gcov) {
    const list = (items) => items.length === 0 ? ' []\n' : `\n${items.map((item) => `  - ${item}\n`).join('')}`;
    return `:gcov:\n  :report_task: ${gcov.reportTask === true}\n  :utilities:${list(gcov.utilities ?? ['gcovr'])}  :reports:${list(gcov.reports ?? [])}`;
}

// Before 1.2.1, Ceedling's gcov task prepends the test file prefix to a name lacking it, so a path
// never names a test file. From 1.2.1 it takes a project-relative path, as test: tasks do.
function gcov(name) {
    const byPath = /^1\.2\.[1-9]|^1\.([3-9]|\d\d)\.|^[2-9]\./.test(scenario.version);
    if (/[\\/]/.test(name) && !byPath) {
        process.stderr.write(`EXCEPTION: Found no file \`test_${name}\` in search paths.\n`);
        process.exitCode = 1;
        return;
    }
    const files = name === 'all' ? ['all'] : Object.keys(scenario.files).filter((file) => file === name || path.basename(file) === name);
    const ran = test(files[0] ?? name, 'gcov');
    const cobertura = (scenario.gcov.reports ?? []).some((report) => report.toLowerCase() === 'cobertura');
    if (ran && cobertura && (!scenario.gcov.reportTask || args.includes('report:gcov'))) {
        writeCobertura(ran);
    }
}

// The test files run, or undefined when the build failed or never finished.
function test(target, context) {
    const files = target === 'all' ? Object.keys(scenario.files) : [target];
    const entries = files.map((file) => [file, scenario.files[file]]);
    if (entries.some(([, entry]) => entry === undefined)) {
        process.stderr.write(`fake ceedling: no scenario for ${target}\n`);
        process.exitCode = 1;
        return undefined;
    }
    if (entries.some(([, entry]) => entry.hang)) {
        setInterval(() => { }, 1 << 30);
        return undefined;
    }
    const broken = entries.find(([, entry]) => entry.compileError);
    if (broken) {
        process.stderr.write(fs.readFileSync(path.join(__dirname, '..', broken[1].compileError), 'utf8'));
        process.exitCode = 1;
        return undefined;
    }
    // Ceedling's --test-case filter selects every function whose name contains it, with all their
    // cases if parametrized.
    const testCase = option('test-case');
    const results = entries.flatMap(([file, entry]) => Object.entries(entry.results)
        .filter(([name]) => testCase === undefined || name.replace(/\(.*$/, '').includes(testCase))
        .map(([name, outcome]) => ({ file, name: `${file}::${name}`, outcome })));
    writeReport(results, context);
    const failed = results.filter((r) => r.outcome.fail !== undefined).length;
    const ignored = results.filter((r) => r.outcome === 'ignore').length;
    process.stdout.write(`TESTED:  ${results.length}\nPASSED:  ${results.length - failed - ignored}\nFAILED:  ${failed}\nIGNORED: ${ignored}\n`);
    if (failed > 0) process.exitCode = 1;
    return files;
}

// A gcovr Cobertura report of the sources the run test files cover, relative to the project.
function writeCobertura(testFiles) {
    const sources = new Map();
    for (const file of testFiles) {
        for (const [source, covered] of Object.entries(scenario.gcov.coverage?.[file] ?? {})) sources.set(source, covered);
    }
    const line = ([number, hits, condition]) => condition === undefined
        ? `<line number="${number}" hits="${hits}" branch="false"/>`
        : `<line number="${number}" hits="${hits}" branch="true" condition-coverage="${condition}"/>`;
    const classes = [...sources].map(([source, covered]) => `<class name="${path.basename(source)}" filename="${source}">` +
        `<methods>${(covered.functions ?? []).map(([name, number, hits]) => `<method name="${name}"><lines>${line([number, hits])}</lines></method>`).join('')}</methods>` +
        `<lines>${covered.lines.map(line).join('')}</lines></class>`).join('');
    const reportDir = path.join(buildRoot, 'artifacts', 'gcov', 'gcovr');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'GcovCoverageCobertura.xml'), '<?xml version="1.0"?>\n<coverage version="gcovr 8.6"><sources><source>.</source></sources>' +
        `<packages><package name="fake"><classes>${classes}</classes></package></packages></coverage>\n`);
}

function writeReport(results, context) {
    const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let id = 0;
    const test = (r, body = '') => `    <Test id="${++id}">\n      <Name>${escape(r.name)}</Name>\n${body}    </Test>\n`;
    const category = (tag, members, body) => members.length === 0 ? `  <${tag}/>\n` : `  <${tag}>\n${members.map((r) => test(r, body(r))).join('')}  </${tag}>\n`;
    const failed = results.filter((r) => r.outcome.fail !== undefined);
    const passed = results.filter((r) => r.outcome === 'pass');
    const ignored = results.filter((r) => r.outcome === 'ignore');
    const xml = '<?xml version="1.0" encoding="utf-8" ?>\n<TestRun name="Fake Project">\n' +
        category('FailedTests', failed, (r) => `      <FailureType>Assertion</FailureType>\n      <Location>\n        <File>${escape(r.file)}</File>\n` +
            `        <Line>${r.outcome.line}</Line>\n      </Location>\n      <Message>${escape(r.outcome.fail)}</Message>\n`) +
        category('SuccessfulTests', passed, () => '') +
        category('IgnoredTests', ignored, () => '') +
        `  <Statistics>\n    <Tests>${results.length}</Tests>\n    <Ignores>${ignored.length}</Ignores>\n    <FailuresTotal>${failed.length}</FailuresTotal>\n` +
        `    <Errors>0</Errors>\n    <Failures>${failed.length}</Failures>\n  </Statistics>\n</TestRun>\n`;
    const reportDir = path.join(buildRoot, 'artifacts', context);
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'cppunit_tests_report.xml'), xml);
}
