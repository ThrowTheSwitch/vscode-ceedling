// Pure, `vscode`-free grouping of test files by folder for ceedlingExplorer.testFileHierarchy, unit-testable in plain Node.

export type TestFolder<T> = {
    // Path relative to the project, '/'-separated with a trailing '/', so it never equals a test file's id.
    id: string,
    label: string,
    folders: TestFolder<T>[],
    files: T[],
};

// `relativePath` is a file's path relative to the project; both '/' and '\' separate folders. The returned root has
// an empty id and holds the top-level folders and the files without a folder.
export function groupByFolder<T>(files: readonly T[], relativePath: (file: T) => string): TestFolder<T> {
    const root: TestFolder<T> = { id: '', label: '', folders: [], files: [] };
    for (const file of files) {
        const names = relativePath(file).split(/[\\/]/);
        names.pop();
        let folder = root;
        for (const name of names) {
            const id = `${folder.id}${name}/`;
            let child = folder.folders.find((f) => f.id === id);
            if (child === undefined) {
                child = { id, label: name, folders: [], files: [] };
                folder.folders.push(child);
            }
            folder = child;
        }
        folder.files.push(file);
    }
    return root;
}

export function filesInFolder<T>(folder: TestFolder<T>): T[] {
    return [...folder.files, ...folder.folders.flatMap((child) => filesInFolder(child))];
}
