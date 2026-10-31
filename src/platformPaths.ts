// Path rules by platform rather than the host's, so Windows paths resolve and compare as Windows
// paths wherever this runs, as the unit tests run them. It has no `vscode` dependency.
import path from 'path';

export type PlatformPaths = typeof path.posix;

export function pathsFor(platform: NodeJS.Platform): PlatformPaths {
    return platform === 'win32' ? path.win32 : path.posix;
}

// One key per file or directory, for comparing paths and for grouping and locking work by
// project directory. Windows paths are case-insensitive, so every spelling of one shares a key.
export function pathKey(absPath: string, platform: NodeJS.Platform): string {
    return platform === 'win32' ? absPath.toLowerCase() : absPath;
}

// Whether two paths, each resolved against `base`, name one file as `platform` compares them.
export function samePath(a: string, b: string, platform: NodeJS.Platform, base: string): boolean {
    const paths = pathsFor(platform);
    return pathKey(paths.resolve(base, a), platform) === pathKey(paths.resolve(base, b), platform);
}
