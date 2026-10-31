// The filesystem the engine works through, and the few operations on it that its modules share.
// Every read goes through the engine's one read limit. It has no `vscode` dependency.
import fs from 'fs';
import path from 'path';
import util from 'util';
import type { Limiter } from './concurrency';
import type { Log } from './log';
import type { PlatformPaths } from './platformPaths';

// The filesystem operations the engine needs, all asynchronous: synchronous I/O would block the
// extension host thread every extension shares. Tests substitute an in-memory implementation.
export interface EngineFileSystem {
    exists(filePath: string): Promise<boolean>;
    isDirectory(filePath: string): Promise<boolean>;
    readFile(filePath: string): Promise<string>;
    unlink(filePath: string): Promise<void>;
    // Every file beneath a directory, at any depth. Empty when the directory doesn't exist.
    listFiles(directory: string): Promise<string[]>;
    // undefined when the file doesn't exist.
    mtimeMs(filePath: string): Promise<number | undefined>;
}

// A missing or unreadable path is undefined rather than an error.
async function statOrUndefined(filePath: string): Promise<fs.Stats | undefined> {
    try {
        return await fs.promises.stat(filePath);
    } catch {
        return undefined;
    }
}

export const nodeFileSystem: EngineFileSystem = {
    exists: async (filePath) => (await statOrUndefined(filePath)) !== undefined,
    isDirectory: async (filePath) => (await statOrUndefined(filePath))?.isDirectory() ?? false,
    readFile: (filePath) => fs.promises.readFile(filePath, 'utf8'),
    unlink: (filePath) => fs.promises.unlink(filePath),
    // One directory at a time, so a deep tree never holds many directory handles open at once.
    listFiles: async (directory) => {
        const found: string[] = [];
        const pending = [directory];
        for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
            // eslint-disable-next-line no-await-in-loop -- one directory at a time, see above
            const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                (entry.isDirectory() ? pending : found).push(path.join(current, entry.name));
            }
        }
        return found.sort();
    },
    mtimeMs: async (filePath) => (await statOrUndefined(filePath))?.mtimeMs,
};

// What the engine's file work runs with. `reads` limits every read the engine makes, together, so
// overlapping discoveries and a burst of reparses can't exhaust file descriptors.
export type EngineIo = { fs: EngineFileSystem, reads: Limiter, paths: PlatformPaths, platform: NodeJS.Platform, log: Log };

export function readText(io: EngineIo, filePath: string): Promise<string> {
    return io.reads.run(() => io.fs.readFile(filePath));
}

export function listUnder(io: EngineIo, directory: string): Promise<string[]> {
    return io.reads.run(() => io.fs.listFiles(directory));
}

// Deletes whichever files exist. A file that won't go is logged, and the work goes ahead.
export async function deleteFiles(io: EngineIo, filePaths: readonly string[]): Promise<void> {
    await Promise.all(filePaths.map((filePath) => io.fs.unlink(filePath).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
            io.log.warn(`Failed to delete stale file '${filePath}': ${util.format(e)}`);
        }
    })));
}

// The first of the paths that exists.
export async function firstPresent(io: EngineIo, filePaths: readonly string[]): Promise<string | undefined> {
    const present = await Promise.all(filePaths.map((filePath) => io.fs.exists(filePath)));
    return filePaths.find((_, i) => present[i]);
}
