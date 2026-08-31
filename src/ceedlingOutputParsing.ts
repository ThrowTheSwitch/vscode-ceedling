// Pure, `vscode`-free parsing helpers for Ceedling's stdout and test source text. Kept free of
// any `vscode`/`child_process`/`fs` dependency so they can be unit-tested directly in plain Node
// (see tests/unit/ceedlingOutputParsing.test.ts), without a real VS Code Extension Host.

// Parses the bullet-pointed file list from `ceedling files:test` stdout.
// Confirmed empirically against real Ceedling output: 1.0.0 emits a "-" bullet, 1.1.0 emits a
// "*" bullet. "•" is kept defensively - never actually observed by us, but an earlier version of
// this code assumed Ceedling's loginator.rb used it, so we keep accepting it in case some other
// release does.
// Normalizes CRLF/CR to LF before splitting - confirmed via a real Windows GitHub Actions runner
// that without this, every line here ends up with a trailing "\r" that "." (which excludes line
// terminators) can never consume, so "(.*)$" can never match and every line is silently dropped.
// This isn't just a checkout-line-ending artifact: Ceedling running natively on Windows plausibly
// emits CRLF in its own stdout too.
export function parseFileListBullets(stdout: string): string[] {
    return stdout.replace(/\r\n?/g, '\n').split('\n')
        .map((value: string) => /^\s*[-•*]\s+(.*)$/.exec(value))
        .filter((match: RegExpExecArray | null): match is RegExpExecArray => match !== null)
        .map((match: RegExpExecArray) => match[1].trim());
}

// Extracts the version string from `ceedling version` stdout (e.g. "1.0.0" or, for a dev build,
// "1.1.0-5bbbc8f"). Returns undefined - rather than logging or defaulting - if no match is found;
// callers decide how to handle that.
export function parseCeedlingVersionString(stdout: string): string | undefined {
    const regex = new RegExp('^\\s*Ceedling\\s*(?:::|=>)\\s*(.*)(?:\\n)*$', 'gm');
    const match = regex.exec(stdout);
    return match ? match[1].trim() : undefined;
}

// Both the test-function regex and the parametrized-case expansion need the same alternation of
// configured TEST_CASE/TEST_RANGE macro aliases; build it once here instead of independently.
export function joinMacroAliases(testCaseAliases: string[], testRangeAliases: string[]): string {
    return [...testCaseAliases, ...testRangeAliases].join('|');
}

// Builds the regex that finds each test function in a test file's source, capturing any
// preceding block of TEST_CASE(...)/TEST_RANGE(...) macro lines as group 1, the function name as
// group 2, and its argument list as group 3.
export function buildTestFunctionRegex(testPrefix: string, testCaseAliases: string[], testRangeAliases: string[]): RegExp {
    const macroAliases = joinMacroAliases(testCaseAliases, testRangeAliases);
    return new RegExp(
        `^((?:\\s*(?:${macroAliases})\\s*\\(.*?\\)\\s*)*)\\s*void\\s+((?:${testPrefix})(?:.*\\\\\\s+)*.*)\\s*\\(\\s*(.*)\\s*\\)`,
        'gm'
    );
}

// Expands a captured TEST_CASE/TEST_RANGE macro-block token string (group 1 from
// buildTestFunctionRegex's match) into a list of parameter sets - one per TEST_CASE, or one per
// value in a TEST_RANGE's [start, end, increment]. Empty array if the test isn't parametrized.
export function expandParametrizedTestCases(
    testCasesToken: string, testCaseAliases: string[], testRangeAliases: string[]
): Array<{ args: string, line: number }> {
    const macroAliases = joinMacroAliases(testCaseAliases, testRangeAliases);
    const regex = new RegExp(`\\s*(${macroAliases})\\s*\\((.*)\\)\\s*$`, 'gm');
    return [...testCasesToken.matchAll(regex)]
        .flatMap((x: any, i: number) => {
            if (testCaseAliases.includes(x[1])) {
                return [{ args: x[2], line: i }]
            } else {
                return [...x[2].matchAll(/\[\s*(-?\d+.?\d*),\s*(-?\d+.?\d*),\s*(-?\d+.?\d*)\s*\]/gm)]
                    .map((y) => [parseFloat(y[1]), parseFloat(y[2]), parseFloat(y[3])])
                    .map(([start, end, inc]) => Array.from({ length: (end - start) / inc + 1 }, (_, j) => start + j * inc))
                    // Seed the accumulator with a single empty combination so a lone range
                    // clause still reduces into an array of arrays (fixes issue #3's
                    // "a.join is not a function" crash when reduce() short-circuits on a
                    // single-element input).
                    .reduce((acc: any, y) => acc.flatMap((u: any) => y.map((v: any) => [u, v].flat())), [[]])
                    .map((y: any) => { return { args: y.join(', '), line: i } })
            }
        });
}

// Strips backslash-newline continuations from a multi-line function signature (group 2 from
// buildTestFunctionRegex's match).
export function normalizeMultilineFunctionName(functionName: string): string {
    return functionName.replace(/\\\s*/g, '');
}

// Builds the regex used to strip a configured test-file prefix (e.g. "test_") from a file path
// for pretty labels, capturing the remainder.
export function buildFileLabelRegex(filePrefix: string): RegExp {
    return new RegExp(`.*\/${filePrefix}(.*).c`, 'i');
}

// Builds the regex used to strip a configured test-function prefix (e.g. "test|spec|should")
// from a function name for pretty labels, capturing the remainder.
export function buildTestLabelRegex(testPrefix: string): RegExp {
    return new RegExp(`(?:${testPrefix})_*(.*)`);
}

// Extracts the bare function name from an XML report's Test Name field, e.g.
// "test/foo.c::test_add_should_ReturnSum" -> "test_add_should_ReturnSum", and
// "test/foo.c::test_add_ParameterizedCases(2, 3, 5)" -> "test_add_ParameterizedCases".
export function extractTestFunctionName(reportedName: string): string {
    const afterFile = reportedName.includes('::') ? reportedName.split('::').pop()! : reportedName;
    const parenIndex = afterFile.indexOf('(');
    return parenIndex === -1 ? afterFile : afterFile.slice(0, parenIndex);
}

// Ceedling's --test-case filter is a substring match, not an exact one. A short function name
// can accidentally also match a longer, unrelated function name that contains it as a prefix.
// Given the function name that was requested and every test name Ceedling actually reported,
// returns true only when every reported test genuinely belongs to the requested function.
// Multiple reported tests are expected and fine when the requested function is parametrized -
// this checks the function name each belongs to, not how many there are.
export function testCaseFilterMatchedExactly(requestedFunctionName: string, reportedNames: string[]): boolean {
    return reportedNames.every((name) => extractTestFunctionName(name) === requestedFunctionName);
}

// Ceedling 1.1.0+'s :use_backtrace: :gdb writes a per-test-case gdb transcript to a log file and
// references its path, relative to the project directory, in parentheses at the end of a crashed
// test's failure message. Splits the message into the text before that reference and the
// referenced path, so a caller with the project's absolute path can turn it into a clickable
// link. Returns the whole message unchanged with no logPath when there's no such reference -
// including all Ceedling 1.0.0 output, which never emits this pattern (1.0.0's backtrace
// generator embeds the filtered gdb text directly in the message, with no separate log file).
export function extractGdbLogReference(message: string): { text: string, logPath: string | undefined } {
    const match = message.match(/\n?\(([^()\n]+\.gdb\.log)\)\s*$/);
    if (!match || match.index === undefined) {
        return { text: message, logPath: undefined };
    }
    return { text: message.slice(0, match.index), logPath: match[1] };
}
