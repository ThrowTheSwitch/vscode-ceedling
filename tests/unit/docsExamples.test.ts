import * as assert from 'assert';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import { getGccPatternsPreset, matchProblems, type MatchedProblem, normalizePatterns } from '../../src/problemMatching';
import { recordingLog } from '../support/fakes';

// The How-To guides' examples are meant to be pasted as they stand, so each one is checked as what
// a marker before it says it is: `<!-- example: <kind> <name> -->`. Compiled tests run from
// out-test/tests/unit, three levels below the repository.
const repository = path.resolve(__dirname, '..', '..', '..');
const howto = path.join(repository, 'docs', 'mkdocs', 'howto');
const fixtures = path.join(repository, 'tests', 'fixtures');
const TOKEN = '${command:ceedlingExplorer.debugTestExecutable}';
const KINDS = ['settings', 'launch', 'workspace', 'mixin', 'patterns'];
// Blocks readers run or read rather than paste into a configuration, which carry no marker.
const UNCHECKED_LANGUAGES = ['sh', 'c'];

type Example = { page: string, kind: string, name: string, lang: string, body: string };
type Block = Example | { page: string, lang: string, kind: undefined };
type Schema = {
    type?: string | string[], enum?: unknown[], required?: string[],
    properties?: Record<string, Schema>, items?: Schema,
};
const contributed = (JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, Schema> } },
}).contributes.configuration.properties;

// Every fenced block of every guide, with the marker on the last non-blank line before it, if any.
// A block inside a content tab is indented, and loses its indent here. A fence this can't read
// fails, so no block escapes the checks.
function blocks(): Block[] {
    return fs.readdirSync(howto).filter((name) => name.endsWith('.md')).flatMap((page) => {
        const lines = fs.readFileSync(path.join(howto, page), 'utf8').split('\n');
        const found: Block[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trimStart().startsWith('```')) {
                continue;
            }
            const open = /^( *)```(\w*)$/.exec(line);
            assert.ok(open, `${page}:${i + 1} has a fence this test can't read: ${line}`);
            const [, indent, lang] = open;
            const close = lines.findIndex((candidate, j) => j > i && candidate === `${indent}\`\`\``);
            assert.ok(close > i, `${page}:${i + 1} opens a fence that never closes`);
            const before = lines.slice(0, i).reverse().find((candidate) => candidate.trim() !== '') ?? '';
            const marker = /^\s*<!-- example: (\w+) ([\w-]+) -->$/.exec(before);
            const body = lines.slice(i + 1, close).map((bodyLine) => bodyLine.slice(indent.length)).join('\n');
            found.push(marker ? { page, kind: marker[1], name: marker[2], lang, body } : { page, lang, kind: undefined });
            i = close;
        }
        return found;
    });
}

function examples(kind: string): Example[] {
    return blocks().filter((block): block is Example => block.kind === kind);
}

// JSON as VS Code reads its settings files, as far as the guides use it: whole lines may be //
// comments.
function jsonc(example: Example): unknown {
    try {
        return JSON.parse(example.body.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'));
    } catch (e) {
        assert.fail(`${example.page}'s ${example.kind} example '${example.name}' isn't valid JSON: ${String(e)}`);
    }
}

function typesOf(value: unknown): string[] {
    if (value === null) return ['null'];
    if (Array.isArray(value)) return ['array'];
    if (typeof value === 'number') return Number.isInteger(value) ? ['integer', 'number'] : ['number'];
    return [typeof value];
}

// A value against package.json's schema for it: its type, enum, required fields, and fields, with
// an unknown field refused where the schema lists them.
function checkValue(where: string, value: unknown, schema: Schema): void {
    const types = [schema.type ?? []].flat();
    assert.ok(types.length === 0 || typesOf(value).some((type) => types.includes(type)), `${where} is a ${typesOf(value)[0]}, not a ${types.join(' or ')}`);
    if (schema.enum) {
        assert.ok(schema.enum.includes(value), `${where} is ${JSON.stringify(value)}, not one of ${JSON.stringify(schema.enum)}`);
    }
    if (Array.isArray(value) && schema.items) {
        const items = schema.items;
        value.forEach((item, i) => { checkValue(`${where}[${i}]`, item, items); });
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && schema.properties) {
        const fields = value as Record<string, unknown>;
        for (const required of schema.required ?? []) {
            assert.ok(required in fields, `${where} lacks its required ${required}`);
        }
        for (const [field, fieldValue] of Object.entries(fields)) {
            const fieldSchema: Schema | undefined = schema.properties[field];
            assert.ok(fieldSchema, `${where} has an unknown field, ${field}`);
            checkValue(`${where}.${field}`, fieldValue, fieldSchema);
        }
    }
}

// Every ceedlingExplorer setting must be one the extension contributes, in any case a typo might
// take, and hold a value its schema allows. Other extensions' settings pass unchecked.
function checkSettings(example: Example, settings: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(settings)) {
        if (!key.toLowerCase().startsWith('ceedlingexplorer.')) {
            continue;
        }
        const schema = contributed[key];
        assert.ok(schema, `${example.page}'s '${example.name}' sets ${key}, which doesn't exist`);
        checkValue(`${example.page}'s '${example.name}' ${key}`, value, schema);
    }
}

const PROBLEM_FIELDS = ['severity', 'file', 'startLine', 'startColumn', 'message'] as const;
type Expected = Pick<MatchedProblem, typeof PROBLEM_FIELDS[number]>;

// What each problem-matching example must find, in captured or documented compiler output.
const PATTERN_CASES: Record<string, { output: string, expected: Expected[] }> = {
    // Real Ceedling 1.2.2 output, which the gcc preset reads too. The notes are what the example
    // adds. The linker reports an absolute path, so its problem keeps it.
    'gcc-with-notes': {
        output: ['compile-diagnostics-stderr.txt', 'link-failure-stderr.txt']
            .map((name) => fs.readFileSync(path.join(fixtures, 'ceedling-1.2.2', name), 'utf8')).join(''),
        expected: [
            { severity: 'error', file: '/ws/project/test/test_diagnostics.c', startLine: 10, startColumn: 25, message: '‘undeclared’ undeclared (first use in this function)' },
            { severity: 'warning', file: '/ws/project/test/test_diagnostics.c', startLine: 9, startColumn: 8, message: 'unused variable ‘unused’ [-Wunused-variable]' },
            { severity: 'error', file: '/project/test/test_unlinked.c', startLine: 10, startColumn: 0, message: 'undefined reference to `unlinked\'' },
            ...[1, 2].flatMap(() => [
                { severity: 'info', file: '/ws/project/build/vendor/unity/src/unity_internals.h', startLine: 1040, startColumn: 158, message: 'in definition of macro ‘UNITY_TEST_ASSERT_EQUAL_INT’' },
                { severity: 'info', file: '/ws/project/test/test_diagnostics.c', startLine: 10, startColumn: 4, message: 'in expansion of macro ‘TEST_ASSERT_EQUAL’' },
            ]),
            { severity: 'info', file: '/ws/project/test/test_diagnostics.c', startLine: 10, startColumn: 25, message: 'each undeclared identifier is reported only once for each function it appears in' },
        ],
    },
    // IAR's documented diagnostic format, `"file",line  Severity[tag]: message`. No IAR compiler
    // was at hand to capture it.
    'iar': {
        output: '"src/main.c",3  Warning[Pe177]: variable "x" was declared but never referenced\n"src/main.c",9  Error[Pe020]: identifier "c" is undefined\n',
        expected: [
            { severity: 'warning', file: '/ws/project/src/main.c', startLine: 2, startColumn: 0, message: 'variable "x" was declared but never referenced' },
            { severity: 'error', file: '/ws/project/src/main.c', startLine: 8, startColumn: 0, message: 'identifier "c" is undefined' },
        ],
    },
};

suite('the How-To examples', () => {
    test('every block a reader pastes is marked as an example of a known kind', () => {
        for (const block of blocks()) {
            if (UNCHECKED_LANGUAGES.includes(block.lang)) {
                continue;
            }
            assert.ok(block.kind !== undefined, `${block.page} has a ${block.lang || 'plain'} block without an example marker`);
            assert.ok(KINDS.includes(block.kind), `${block.page}'s example '${block.name}' is of no known kind, '${block.kind}'`);
        }
    });

    test('every settings example sets only contributed settings, with values their schemas allow', () => {
        assert.ok(examples('settings').length > 0);
        for (const example of examples('settings')) {
            checkSettings(example, jsonc(example) as Record<string, unknown>);
        }
    });

    test('every workspace example lists folders, and sets only contributed settings', () => {
        assert.ok(examples('workspace').length > 0);
        for (const example of examples('workspace')) {
            const workspace = jsonc(example) as { folders?: Array<{ path?: unknown }>, settings?: Record<string, unknown> };
            assert.ok(Array.isArray(workspace.folders) && workspace.folders.every((folder) => typeof folder.path === 'string'), `${example.page}'s '${example.name}' lists no folders`);
            checkSettings(example, workspace.settings ?? {});
        }
    });

    test('every launch example names the test executable with the extension’s token', () => {
        assert.ok(examples('launch').length > 0);
        for (const example of examples('launch')) {
            const launch = jsonc(example) as Record<string, unknown> & { configurations?: Array<Record<string, unknown>> };
            for (const configuration of launch.configurations ?? [launch]) {
                for (const field of ['name', 'type', 'request']) {
                    assert.strictEqual(typeof configuration[field], 'string', `${example.page}'s '${example.name}' has no ${field}`);
                }
                assert.ok(String(configuration.program).includes(TOKEN), `${example.page}'s '${example.name}' program lacks ${TOKEN}`);
            }
        }
    });

    test('every mixin example is Ceedling YAML', () => {
        assert.ok(examples('mixin').length > 0);
        for (const example of examples('mixin')) {
            const mixin = yaml.safeLoad(example.body) as unknown;
            assert.ok(typeof mixin === 'object' && mixin !== null && !Array.isArray(mixin), `${example.page}'s '${example.name}' isn't a YAML mapping`);
            assert.deepStrictEqual(Object.keys(mixin).filter((key) => !key.startsWith(':')), [], `${example.page}'s '${example.name}' has keys that aren't Ceedling symbols`);
        }
    });

    test('every problem-matching example finds exactly what its compiler reports', () => {
        const names = examples('patterns').map((example) => example.name).sort();
        assert.deepStrictEqual(names, Object.keys(PATTERN_CASES).sort());
        for (const example of examples('patterns')) {
            const settings = jsonc(example) as { 'ceedlingExplorer.problemMatching': { mode: string, patterns: unknown[] } };
            checkSettings(example, settings);
            const { mode, patterns } = settings['ceedlingExplorer.problemMatching'];
            const found = matchProblems({ stdout: '', stderr: PATTERN_CASES[example.name].output }, '/ws/project', mode, patterns, recordingLog(() => {}), path.posix);
            // In any order, since the order follows the patterns, not the output.
            const sorted = (problems: ReadonlyArray<Partial<MatchedProblem>>) => problems.map((problem) => JSON.stringify(PROBLEM_FIELDS.map((field) => problem[field]))).sort();
            assert.deepStrictEqual(sorted(found), sorted(PATTERN_CASES[example.name].expected), example.name);
        }
    });

    // Custom patterns replace the preset, so an example extending it must restate it. A field left
    // at its default may be left out.
    test('the example extending the gcc preset starts with the preset itself', () => {
        const [example] = examples('patterns').filter((e) => e.name === 'gcc-with-notes');
        assert.ok(example);
        const { patterns } = (jsonc(example) as { 'ceedlingExplorer.problemMatching': { patterns: unknown[] } })['ceedlingExplorer.problemMatching'];
        const preset = getGccPatternsPreset();
        assert.deepStrictEqual(normalizePatterns(patterns.slice(0, preset.length)).valid, preset);
    });
});
