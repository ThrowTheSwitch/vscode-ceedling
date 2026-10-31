// Parsing for Ceedling's console output, its report names, and the Testing view's pretty labels.
// It has no `vscode`, `child_process`, or `fs` dependency, so it is unit-tested in plain Node.

// The files listed in `ceedling files:test` stdout, one per bullet line. Ceedling 1.0.0 bullets
// with "-", 1.1.0 and later with "*". "•" is accepted as well. CRLF output is normalized first.
// Otherwise a trailing "\r" on every line defeats the line pattern and the list comes back empty,
// as it did on a real Windows runner.
export function parseFileListBullets(stdout: string): string[] {
    return stdout.replace(/\r\n?/g, '\n').split('\n')
        .map((line) => /^\s*[-•*]\s+(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => (match[1] ?? '').trim());
}

// The Ceedling builds `ceedling version` reports, e.g. "1.0.0" or a build's "1.1.0-5bbbc8f".
// `application` runs the project. `launcher`, the Ceedling that `ceedling` starts, appears only when
// it hands off to another installation, e.g. one vendored in the project's `vendor/ceedling` or
// named by WHICH_CEEDLING. Even a copy of the same build counts as another.
export type ReportedCeedling = { application: string, launcher?: string };

// undefined when stdout names no application. The caller decides what that means.
export function parseCeedlingVersions(stdout: string): ReportedCeedling | undefined {
    const line = (label: string) => new RegExp(`^\\s*Ceedling${label}\\s*(?:::|=>)\\s*(.*)$`, 'm').exec(stdout)?.[1]?.trim();
    const launcher = line(' Launcher');
    // Without a launcher line, the plain `Ceedling =>` line names the application.
    const application = launcher === undefined ? line('') : line(' App');
    if (application === undefined) {
        return undefined;
    }
    return launcher === undefined ? { application } : { application, launcher };
}

// Captures a test file's pretty label: its name after the configured prefix, without directory or
// `.c` extension. The prefix must begin the file's name, after either path separator.
export function buildFileLabelRegex(filePrefix: string): RegExp {
    return new RegExp(`(?:^|[\\\\/])${filePrefix}(.*)\\.c$`, 'i');
}

// Captures a test function's pretty label: its name after the configured prefix (a regex
// alternation such as "test|spec|should") and any underscores following it.
export function buildTestLabelRegex(testPrefix: string): RegExp {
    return new RegExp(`^(?:${testPrefix})_*(.*)`);
}

// The function name within a reported test name, without its file or parametrized arguments:
// "test/foo.c::test_add(2, 3)" gives "test_add". The file ends at the first `::`, since a case's
// arguments may contain one, e.g. a string.
export function extractTestFunctionName(reportedName: string): string {
    const separator = reportedName.indexOf('::');
    const afterFile = separator === -1 ? reportedName : reportedName.slice(separator + 2);
    const parenIndex = afterFile.indexOf('(');
    return parenIndex === -1 ? afterFile : afterFile.slice(0, parenIndex);
}

// Whether a --test-case run reported only the requested function. Ceedling's filter is a
// substring match, so `test_add` also selects `test_add_more`. Several reported names are fine
// when they are one parametrized function's cases.
export function testCaseFilterMatchedExactly(requestedFunctionName: string, reportedNames: string[]): boolean {
    return reportedNames.every((name) => extractTestFunctionName(name) === requestedFunctionName);
}

// Splits a crash message from Ceedling 1.1.0+'s `:use_backtrace: :gdb` into its text and the gdb
// log path it ends with, in parentheses and relative to the project directory. A caller turns
// that path into a link. A message without one, including all Ceedling 1.0.0 output, comes back
// whole. That version embeds the gdb text in the message instead of writing a log.
export function extractGdbLogReference(message: string): { text: string, logPath: string | undefined } {
    const match = message.match(/\n?\(([^()\n]+\.gdb\.log)\)\s*$/);
    if (match?.index === undefined) {
        return { text: message, logPath: undefined };
    }
    return { text: message.slice(0, match.index), logPath: match[1] };
}

// Why Ceedling stopped, from its console output: the EXCEPTION line and whatever output it carries,
// such as a compiler's errors, up to the closing "could not complete operations" line. A decorated
// console leads the line with an emoji, which is dropped. undefined when Ceedling raised none.
export function extractCeedlingException(output: string): string | undefined {
    const lines = output.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((line) => /^[^\w\s]*\s*EXCEPTION:/.test(line));
    if (start < 0) {
        return undefined;
    }
    const closing = lines.findIndex((line, i) => i > start && /^[^\w\s]*\s*Ceedling could not complete operations/.test(line));
    const block = lines.slice(start, closing < 0 ? undefined : closing);
    block[0] = (block[0] ?? '').replace(/^[^\w\s]*\s*/, '');
    return block.join('\n').trimEnd();
}

// Whether a build's output carries Ceedling's warning that its dependency cache comes from an
// earlier build layout, as on the first build after upgrading to 1.2.2 from 1.2.0 or 1.2.1. The
// old layout's output stays until a clobber. The warning's key words, all on one line in any case,
// identify it, so a reworded, decorated, or wrapped-path warning still counts.
const LAYOUT_UPGRADE_WORDS = [/dependency cache/i, /\bearlier\b/i, /build layout/i, /\bclobber\b/i];

export function detectLayoutUpgrade(output: string): boolean {
    return output.split(/\r\n?|\n/).some((line) => LAYOUT_UPGRADE_WORDS.every((word) => word.test(line)));
}
