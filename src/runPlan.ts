// Turns a Testing view run request into the fewest Ceedling invocations that cover it. Ceedling
// always compiles a whole test file, and its --test-case filter narrows a run to one function,
// never to one parametrized case. So a run plan has three granularities: a whole project
// (`test:all`), a whole file, or one function in a file. It has no `vscode` dependency. The
// controller translates TestItems into PlanTargets.

import { CeedlingFileNode, CeedlingProjectNode, CeedlingTestFunction } from './testModel';

export type PlanTarget =
    | { kind: 'project', projectKey: string }
    | { kind: 'file', projectKey: string, fileId: string }
    | { kind: 'function', projectKey: string, fileId: string, functionId: string }
    | { kind: 'case', projectKey: string, fileId: string, functionId: string, caseId: string };

export type RunPlanEntry =
    | { kind: 'project', projectKey: string, files: CeedlingFileNode[] }
    | { kind: 'file', projectKey: string, file: CeedlingFileNode }
    | { kind: 'function', projectKey: string, file: CeedlingFileNode, fn: CeedlingTestFunction };

// `whole` means every function, including any discovered after selection.
type FileSelection = { whole: boolean, functions: Set<string> };
type ProjectSelection = { whole: boolean, files: Map<string, FileSelection> };

// `include` undefined means run everything, file by file. A project-wide `test:all` runs only
// when a project itself is included and nothing within it is excluded. A file whose every
// function is selected runs as the file. An excluded case can't be left out of its function's
// run, so its function still runs unless every one of its cases is excluded. Entries follow tree
// order, and targets naming nothing in the tree are ignored.
export function buildRunPlan(
    projects: readonly CeedlingProjectNode[], include: readonly PlanTarget[] | undefined, exclude: readonly PlanTarget[],
): RunPlanEntry[] {
    const tree = new Map(projects.map((project) => [project.projectKey, project]));
    const findFile = (projectKey: string, fileId: string) => tree.get(projectKey)?.files.find((f) => f.id === fileId);
    const selection = new Map<string, ProjectSelection>();
    const selectProject = (projectKey: string) => getOrAdd(selection, projectKey, () => ({ whole: false, files: new Map() }));
    const selectFile = (projectKey: string, fileId: string) =>
        getOrAdd(selectProject(projectKey).files, fileId, () => ({ whole: false, functions: new Set<string>() }));

    for (const target of include ?? projects.map((p): PlanTarget => ({ kind: 'project', projectKey: p.projectKey }))) {
        if (target.kind === 'project') {
            const project = tree.get(target.projectKey);
            if (!project) continue;
            selectProject(project.projectKey).whole = include !== undefined;
            for (const file of project.files) {
                selectFile(project.projectKey, file.id).whole = true;
            }
        } else if (target.kind === 'file') {
            if (findFile(target.projectKey, target.fileId)) {
                selectFile(target.projectKey, target.fileId).whole = true;
            }
        } else {
            const fn = findFile(target.projectKey, target.fileId)?.functions.find((f) => f.id === target.functionId);
            if (fn) {
                selectFile(target.projectKey, target.fileId).functions.add(fn.id);
            }
        }
    }

    const excludeFunction = (projectKey: string, fileId: string, functionId: string) => {
        const projectSelection = selection.get(projectKey);
        const fileSelection = projectSelection?.files.get(fileId);
        const file = findFile(projectKey, fileId);
        if (!projectSelection || !fileSelection || !file) return;
        if (fileSelection.whole) {
            fileSelection.whole = false;
            fileSelection.functions = new Set(file.functions.map((fn) => fn.id));
        }
        fileSelection.functions.delete(functionId);
        projectSelection.whole = false;
    };
    const excludedCases = new Map<string, { projectKey: string, fileId: string, functionId: string, caseIds: Set<string> }>();
    for (const target of exclude) {
        if (target.kind === 'project') {
            selection.delete(target.projectKey);
        } else if (target.kind === 'file') {
            const projectSelection = selection.get(target.projectKey);
            if (projectSelection) {
                projectSelection.files.delete(target.fileId);
                projectSelection.whole = false;
            }
        } else if (target.kind === 'function') {
            excludeFunction(target.projectKey, target.fileId, target.functionId);
        } else {
            const key = `${target.projectKey}\0${target.functionId}`;
            getOrAdd(excludedCases, key, () => ({ ...target, caseIds: new Set<string>() })).caseIds.add(target.caseId);
        }
    }
    for (const { projectKey, fileId, functionId, caseIds } of excludedCases.values()) {
        const fn = findFile(projectKey, fileId)?.functions.find((f) => f.id === functionId);
        if (fn && fn.cases.every((c) => caseIds.has(c.id))) {
            excludeFunction(projectKey, fileId, functionId);
        }
    }

    const plan: RunPlanEntry[] = [];
    for (const project of projects) {
        const projectSelection = selection.get(project.projectKey);
        if (!projectSelection) continue;
        if (projectSelection.whole && project.files.every((file) => projectSelection.files.get(file.id)?.whole)) {
            plan.push({ kind: 'project', projectKey: project.projectKey, files: project.files });
            continue;
        }
        for (const file of project.files) {
            const fileSelection = projectSelection.files.get(file.id);
            if (!fileSelection) continue;
            const everyFunction = file.functions.length > 0 && file.functions.every((fn) => fileSelection.functions.has(fn.id));
            if (fileSelection.whole || everyFunction) {
                plan.push({ kind: 'file', projectKey: project.projectKey, file });
                continue;
            }
            for (const fn of file.functions) {
                if (fileSelection.functions.has(fn.id)) {
                    plan.push({ kind: 'function', projectKey: project.projectKey, file, fn });
                }
            }
        }
    }
    return plan;
}

function getOrAdd<K, V>(map: Map<K, V>, key: K, create: () => V): V {
    let value = map.get(key);
    if (value === undefined) {
        value = create();
        map.set(key, value);
    }
    return value;
}
