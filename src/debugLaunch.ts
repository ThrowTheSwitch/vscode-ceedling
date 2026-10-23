// What a Testing view debug request debugs, and the launch configuration that debugs it. It has
// no `vscode` dependency. The controller starts the debug session.

import { type RunPlanEntry } from './runPlan';
import { type CeedlingFileNode } from './testModel';

// The launch.json token that stands for the built test executable, relative to Ceedling's test
// output directory.
const EXECUTABLE_TOKEN = /\$\{command:ceedlingExplorer\.debugTestExecutable\}/g;

// Ceedling builds a whole test file into one executable, so a request covering several files
// debugs the first. `severalFiles` says the rest were left out.
export function debugTarget(plan: readonly RunPlanEntry[]): { file: CeedlingFileNode, severalFiles: boolean } | undefined {
    const files = plan.flatMap((entry) => entry.kind === 'project' ? entry.files : [entry.file]);
    const file = files[0];
    if (!file) {
        return undefined;
    }
    return { file, severalFiles: new Set(files.map((f) => `${f.projectKey}::${f.id}`)).size > 1 };
}

// A copy of the named configuration with the executable's path spliced into every occurrence of
// the token. VS Code never resolves the token itself, so debugging doesn't depend on when it
// would. undefined when launch.json has no configuration of that name.
export function resolveLaunchConfig<Config extends { name: string }>(configurations: readonly Config[], name: string, executableSubpath: string): Config | undefined {
    const found = configurations.find((c) => c.name === name);
    if (!found) {
        return undefined;
    }
    return splice(found, executableSubpath) as Config;
}

// A deep copy with the token replaced in every string. Replacing within strings, rather than in
// serialized JSON, keeps a backslash or quote in the path from being read as JSON escaping.
function splice(value: unknown, executableSubpath: string): unknown {
    if (typeof value === 'string') {
        return value.replace(EXECUTABLE_TOKEN, () => executableSubpath);
    }
    if (Array.isArray(value)) {
        return value.map((element) => splice(element, executableSubpath));
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, element]) => [key, splice(element, executableSubpath)]));
    }
    return value;
}
