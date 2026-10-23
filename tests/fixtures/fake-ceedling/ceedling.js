#!/usr/bin/env node
// A stand-in for `ceedling` in the integration tests, run as `node ceedling.js <args>` from a
// project directory. It answers the commands the extension runs the way Ceedling 1.2.0 does, from
// the project's `fake-ceedling.json` scenario:
//
//   { "version": "1.2.0",
//     "files": { "test/test_x.c": { "results": { "test_a": "pass", "test_b": { "fail": "Expected 1 Was 2", "line": 9 },
//                                                "test_c": "ignore", "test_p(1)": "pass" } },
//                "test/test_y.c": { "compileError": "ceedling-1.0.0/compile-failure-stderr.txt" },
//                "test/test_z.c": { "hang": true } } }
//
// A result left out of `results` goes unreported, as when discovery and Ceedling disagree on a
// name. `compileError` names a captured compiler failure under tests/fixtures. `hang` runs until
// the process is killed. Reports follow the structure of the captured CppUnit reports. Every
// invocation's arguments are appended to `fake-ceedling.log` as a JSON line.
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
        `:project:\n  :build_root: build\n:plugins:\n  :enabled:\n${reporting ? '  - report_tests_log_factory\n' : ''}` +
        ':unity:\n  :use_param_tests: true\n');
} else if (task === 'files:test') {
    process.stdout.write(`Test files:\n${testFiles().map((f) => ` - ${f}`).join('\n')}\n`);
} else if (task.startsWith('test:')) {
    test(task.slice('test:'.length));
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

function test(target) {
    const files = target === 'all' ? Object.keys(scenario.files) : [target];
    const entries = files.map((file) => [file, scenario.files[file]]);
    if (entries.some(([, entry]) => entry === undefined)) {
        process.stderr.write(`fake ceedling: no scenario for ${target}\n`);
        process.exitCode = 1;
        return;
    }
    if (entries.some(([, entry]) => entry.hang)) {
        setInterval(() => { }, 1 << 30);
        return;
    }
    const broken = entries.find(([, entry]) => entry.compileError);
    if (broken) {
        process.stderr.write(fs.readFileSync(path.join(__dirname, '..', broken[1].compileError), 'utf8'));
        process.exitCode = 1;
        return;
    }
    // Ceedling's --test-case filter selects every function whose name contains it, with all their
    // cases if parametrized.
    const testCase = option('test-case');
    const results = entries.flatMap(([file, entry]) => Object.entries(entry.results)
        .filter(([name]) => testCase === undefined || name.replace(/\(.*$/, '').includes(testCase))
        .map(([name, outcome]) => ({ file, name: `${file}::${name}`, outcome })));
    writeReport(results);
    const failed = results.filter((r) => r.outcome.fail !== undefined).length;
    const ignored = results.filter((r) => r.outcome === 'ignore').length;
    process.stdout.write(`TESTED:  ${results.length}\nPASSED:  ${results.length - failed - ignored}\nFAILED:  ${failed}\nIGNORED: ${ignored}\n`);
    if (failed > 0) process.exitCode = 1;
}

function writeReport(results) {
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
    const reportDir = path.join(buildRoot, 'artifacts', 'test');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'cppunit_tests_report.xml'), xml);
}
