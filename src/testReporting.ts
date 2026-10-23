// Turns the engine's results, reported by id, into calls on a Testing view run. Results for ids
// with no test item are dropped with a warning, and excluded items get nothing. Messages are
// plain data here, so this has no `vscode` dependency. The controller's RunSink builds the
// TestMessages, links, and locations from them.

import path from 'path';
import { extractGdbLogReference } from './ceedlingOutputParsing';
import { type CoverageOutcome, type RunReporter } from './testModel';

export type ReportMessage = {
    text: string,
    // A crash's gdb log, shown as a link to the file.
    log?: { label: string, absPath: string },
    // A 0-based line in `file`, or in the test's own file when `file` is absent.
    location?: { line: number, file?: string },
};

// A test run, as the reporter calls it, with each id already resolved to its item.
export interface RunSink<Item> {
    started(item: Item): void;
    passed(item: Item): void;
    failed(item: Item, message: ReportMessage): void;
    skipped(item: Item): void;
    errored(item: Item, message: ReportMessage): void;
    appendOutput(text: string): void;
    coverage(outcome: CoverageOutcome): void;
}

export type RunReporterOptions<Item> = {
    sink: RunSink<Item>,
    projectKey: string,
    find: (id: string) => Item | undefined,
    // An excluded item can still be run, e.g. one case of a function, but reports nothing.
    excluded: (item: Item) => boolean,
    // Looked up only for a gdb log link, whose path is relative to the project directory.
    projectAbsPath: () => string,
    warn: (message: string) => void,
};

export function createRunReporter<Item>(options: RunReporterOptions<Item>): RunReporter {
    const { sink, projectKey, find, excluded, projectAbsPath, warn } = options;
    // Each reporting call runs `report` with the id's item, unless there is none to report to.
    const withItem = (callback: string, id: string, report: (item: Item) => void) => {
        const item = find(id);
        if (item === undefined) {
            warn(`makeReporter.${callback}: no TestItem for '${id}' in project '${projectKey}', dropping this result`);
        } else if (!excluded(item)) {
            report(item);
        }
    };
    return {
        started: (id) => { withItem('started', id, (item) => { sink.started(item); }); },
        passed: (id) => { withItem('passed', id, (item) => { sink.passed(item); }); },
        failed: (id, message, line) => {
            withItem('failed', id, (item) => {
                // Ceedling 1.1.0+'s :use_backtrace: :gdb ends a crash message with a gdb log path,
                // relative to the project directory.
                const { text, logPath } = extractGdbLogReference(message);
                sink.failed(item, {
                    text,
                    ...(logPath !== undefined && { log: { label: logPath, absPath: path.resolve(projectAbsPath(), logPath) } }),
                    ...(line !== undefined && { location: { line } }),
                });
            });
        },
        skipped: (id) => { withItem('skipped', id, (item) => { sink.skipped(item); }); },
        errored: (id, message, location) => {
            withItem('errored', id, (item) => { sink.errored(item, { text: message, ...(location && { location }) }); });
        },
        appendOutput: (text) => { sink.appendOutput(text); },
        coverage: (outcome) => { sink.coverage(outcome); },
    };
}
