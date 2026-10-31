// A project's test files as the Testing view's nodes: each file's test functions and parametrized
// cases, found in its source, with pretty labels when they're on. Ids name tests as Ceedling's
// report does, `file::function` and `file::function(args)`. It has no `vscode` dependency.
import util from 'util';
import { buildFileLabelRegex, buildTestLabelRegex } from './ceedlingOutputParsing';
import type { LoadedProject } from './ceedlingProjectConfig';
import { type EngineIo, readText } from './engineFileSystem';
import type { CeedlingFileNode } from './testModel';
import { discoverTests } from './unityTestDiscovery';

// `source`, when given, stands in for the contents of a single file. Sources are read concurrently,
// within the engine's shared read limit, then parsed in listed order. A file that can't be read or
// parsed is left out, with a warning.
export async function testFileNodes(
    io: EngineIo, project: LoadedProject, files: readonly string[], pretty: { tests: boolean, files: boolean }, source?: string,
): Promise<CeedlingFileNode[]> {
    const options = { testPrefix: project.state.testPrefix, useParamTests: project.state.useParamTests };
    const testLabel = pretty.tests ? labelRegex(io, () => buildTestLabelRegex(project.state.testPrefix)) : undefined;
    const fileLabel = pretty.files ? labelRegex(io, () => buildFileLabelRegex(project.state.testFilePrefix)) : undefined;
    // `||`, not `??`: an empty capture, such as a file named only by its prefix, keeps the full text.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- see above
    const label = (regex: RegExp | undefined, text: string) => regex?.exec(text)?.[1] || text;
    const sources = await Promise.all(files.map(async (file) => {
        const absPath = io.paths.resolve(project.absPath, file);
        try {
            return { file, absPath, text: source ?? await readText(io, absPath) };
        } catch (error) {
            return { file, absPath, error };
        }
    }));
    const nodes: CeedlingFileNode[] = [];
    for (const { file, absPath, text, error } of sources) {
        let discovered: ReturnType<typeof discoverTests>;
        try {
            if (text === undefined) {
                throw error;
            }
            discovered = discoverTests(text, options);
        } catch (e) {
            // An unreadable file, or a :test_runner: :test_prefix: that isn't a valid regex.
            io.log.warn(`testFileNodes: skipping '${absPath}' (test prefix '${options.testPrefix}'): ${util.format(e)}`);
            continue;
        }
        for (const warning of discovered.warnings) {
            io.log.warn(`testFileNodes: '${file}': ${warning}`);
        }
        nodes.push({
            id: file,
            label: label(fileLabel, file),
            absPath,
            projectKey: project.key,
            functions: discovered.tests.map((test) => ({
                id: `${file}::${test.name}`,
                label: label(testLabel, test.name),
                line: test.line,
                cases: test.cases.map((testCase) => ({ id: `${file}::${test.name}(${testCase.args})`, label: testCase.args, line: testCase.line })),
            })),
        });
    }
    return nodes;
}

// A pretty-label pattern built from a configured prefix, or none if the prefix is invalid.
function labelRegex(io: EngineIo, build: () => RegExp): RegExp | undefined {
    try {
        return build();
    } catch (e) {
        io.log.warn(`Pretty labels are unavailable: ${util.format(e)}`);
        return undefined;
    }
}
