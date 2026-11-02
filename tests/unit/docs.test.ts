import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { capabilitiesOf, type CeedlingFeature, firstRelease, launcherCapabilitiesOf, type LauncherFeature } from '../../src/ceedlingVersions';

// Documentation that restates code, checked against it so the two can't drift apart.
suite('Architecture.md', () => {
    // Its version table lists every feature with its first release, application's or launcher's.
    test('the version table lists every feature at its first release', () => {
        const architecture = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'Architecture.md'), 'utf8');
        const rows = [...architecture.matchAll(/^\| `(\w+)` \| (\d+\.\d+\.\d+) \| (Application|Launcher) \|/gm)].map((m) => `${m[3]} ${m[1]} ${m[2]}`).sort();
        const features = [
            ...(Object.keys(capabilitiesOf('1.0.0')) as CeedlingFeature[]).map((f) => `Application ${f} ${firstRelease(f)}`),
            ...(Object.keys(launcherCapabilitiesOf('1.0.0')) as LauncherFeature[]).map((f) => `Launcher ${f} ${firstRelease(f)}`),
        ].sort();
        assert.deepStrictEqual(rows, features);
    });
});

// Compiled tests run from out-test/tests/unit, three levels below the repository.
const repository = path.resolve(__dirname, '..', '..', '..');
const siteDirectory = path.join(repository, 'docs', 'mkdocs');
const SITE = 'https://docs.throwtheswitch.org/vscode-ceedling/latest/';

type Contributed = {
    configuration: { properties: Record<string, { default?: unknown, items?: { properties?: Record<string, unknown> } }> },
    commands: Array<{ command: string }>,
};
const contributes = (JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')) as { contributes: Contributed }).contributes;

function read(...segments: string[]): string {
    return fs.readFileSync(path.join(...segments), 'utf8');
}

// Every page of the site, by its path under docs/mkdocs.
function sitePages(directory = siteDirectory): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? sitePages(full) : entry.name.endsWith('.md') ? [path.relative(siteDirectory, full)] : [];
    });
}

// A heading's text through the next heading of its level or higher, or undefined without it.
function section(markdown: string, heading: string): string | undefined {
    const lines = markdown.split('\n');
    const start = lines.indexOf(heading);
    if (start < 0) {
        return undefined;
    }
    const level = /^#+/.exec(heading)?.[0].length ?? 0;
    const end = lines.findIndex((line, i) => i > start && (/^#+ /.exec(line)?.[0].length ?? Infinity) - 1 <= level);
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

// The anchors MkDocs gives a page's headings, slugified as Python-Markdown's toc extension does,
// from the heading's text with its code and bold markers gone. Headings here use no other markup.
function anchors(markdown: string): Set<string> {
    const withoutCode = markdown.replace(/^```[\s\S]*?^```/gm, '');
    return new Set([...withoutCode.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]
        .replace(/[`*]/g, '')
        .normalize('NFKD').replace(/[\u0080-\uffff]/g, '')
        .replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[-\s]+/g, '-')));
}

suite('the documentation site', () => {
    const configurationPage = () => read(siteDirectory, 'manual', 'configuration.md');

    // VS Code shows package.json's defaults in its Settings editor, so the page must agree with them.
    // A setting with no default of its own, whose fields have defaults instead, says "Default: none".
    test('the configuration page documents every setting with its default', () => {
        const configuration = configurationPage();
        for (const [key, property] of Object.entries(contributes.configuration.properties)) {
            const entry = section(configuration, `### \`${key}\``);
            assert.ok(entry !== undefined, `no "### \`${key}\`" entry`);
            const expected = property.default === undefined ? 'Default: none' : `Default: \`${JSON.stringify(property.default)}\``;
            assert.ok(entry.includes(expected), `${key}'s entry doesn't say "${expected}"`);
        }
    });

    test("the configuration page documents every field of a project's entry", () => {
        const entry = section(configurationPage(), '### `ceedlingExplorer.projects`') ?? '';
        for (const field of Object.keys(contributes.configuration.properties['ceedlingExplorer.projects'].items?.properties ?? {})) {
            assert.ok(entry.includes(`\`${field}\``), `no "${field}" in ceedlingExplorer.projects's entry`);
        }
    });

    test('the configuration page lists every command', () => {
        const commands = section(configurationPage(), '## Commands') ?? '';
        for (const { command } of contributes.commands) {
            assert.ok(commands.includes(`\`${command}\``), `no "${command}" under Commands`);
        }
    });

    // A renamed setting would otherwise leave pages naming one that does nothing. A retired name is
    // named only to say it's gone.
    test('every ceedlingExplorer name the site and README use is a setting or a command', () => {
        const retired = ['debugConfiguration'];
        const registered = [...read(repository, 'src', 'main.ts').matchAll(/registerCommand\("ceedlingExplorer\.(\w+)"/g)].map((m) => m[1]);
        const known = new Set([
            ...Object.keys(contributes.configuration.properties).map((key) => key.replace(/^ceedlingExplorer\./, '')),
            ...registered, ...retired,
        ]);
        assert.ok(retired.every((name) => !(`ceedlingExplorer.${name}` in contributes.configuration.properties)));
        const documents = [...sitePages().map((page) => path.join(siteDirectory, page)), path.join(repository, 'README.md')];
        for (const document of documents) {
            for (const [, name] of read(document).matchAll(/ceedlingExplorer\.(\w+)/g)) {
                assert.ok(known.has(name), `${path.relative(repository, document)} names ceedlingExplorer.${name}, which doesn't exist`);
            }
        }
    });

    // The site's own build checks its internal links. These come from outside it, and break silently.
    test('every link into the site names a page and heading it has', () => {
        const sources = [
            'README.md', 'CHANGELOG.md', 'package.json',
            ...fs.readdirSync(path.join(repository, 'docs')).filter((name) => name.endsWith('.md')).map((name) => path.join('docs', name)),
            ...fs.readdirSync(path.join(repository, 'src')).filter((name) => name.endsWith('.ts')).map((name) => path.join('src', name)),
        ];
        const escaped = SITE.replace(/[.]/g, '\\.');
        for (const source of sources) {
            // A link runs to whitespace or a closing delimiter. Sentence punctuation after it isn't its own.
            const links = [...read(repository, source).matchAll(new RegExp(`${escaped}[^\\s)"'\`>\\]]*`, 'g'))].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
            for (const link of links) {
                const parsed = /^([\w/-]*?)\/?(?:#([\w-]+))?$/.exec(link.slice(SITE.length));
                assert.ok(parsed, `${source} links ${link}, which isn't a page and heading`);
                const [, page, anchor] = parsed;
                const candidates = page === '' ? ['index.md'] : [`${page}.md`, path.join(page, 'index.md')];
                const found = candidates.find((candidate) => fs.existsSync(path.join(siteDirectory, candidate)));
                assert.ok(found !== undefined, `${source} links ${link}, which names no page`);
                // An absent group is undefined at run time, whatever its type says.
                if (anchor) {
                    assert.ok(anchors(read(siteDirectory, found)).has(anchor), `${source} links ${link}, whose page has no #${anchor}`);
                }
            }
        }
    });
});
