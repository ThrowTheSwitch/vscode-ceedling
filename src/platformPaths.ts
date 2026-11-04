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

// `filePath` by way of a link, where `realDir` is `linkDir` with its symlinks resolved. The two share
// the trailing segments beneath the link, so what precedes those is the link and its target, and a
// path beneath the target maps across, one above the project as well as one within it. A target at
// a filesystem root would claim every path, so it maps none, as do a path elsewhere and a directory
// with no link.
export function viaLink(filePath: string, linkDir: string, realDir: string, platform: NodeJS.Platform): string | undefined {
    const paths = pathsFor(platform);
    let link = paths.resolve(linkDir);
    let target = paths.resolve(realDir);
    while (paths.basename(link) !== '' && pathKey(paths.basename(link), platform) === pathKey(paths.basename(target), platform)) {
        link = paths.dirname(link);
        target = paths.dirname(target);
    }
    if (pathKey(link, platform) === pathKey(target, platform) || paths.dirname(target) === target) {
        return undefined;
    }
    const rest = paths.relative(target, filePath);
    if (rest === '..' || rest.startsWith(`..${paths.sep}`) || paths.isAbsolute(rest)) {
        return undefined;
    }
    return paths.join(link, rest);
}
