// Test discovery that names every test exactly as Ceedling reports it. Ceedling builds each test
// runner with Unity's generator (auto/generate_test_runner.rb#find_tests), and its reports use
// that generator's test names. This module ports that discovery to TypeScript: comment
// stripping, logical-line splitting, the test-function pattern, and TEST_CASE/TEST_RANGE/
// TEST_MATRIX expansion, including Ruby's float stepping and formatting. Any divergence leaves a
// discovered item that no reported result ever reaches. It has no `vscode` dependency, so it
// runs in plain Node unit tests (tests/unit/unityTestDiscovery.test.ts).

export type DiscoveryOptions = {
    // A regex alternation, used unescaped as Unity uses `:test_runner` ↳ `:test_prefix`.
    testPrefix: string,
    // `:unity` ↳ `:use_param_tests`. When false, Unity ignores every parametrization marker.
    useParamTests: boolean,
};

// `line` values are 0-based, matching vscode.Position.
export type DiscoveredCase = { args: string, line: number };
export type DiscoveredTest = { name: string, line: number, cases: DiscoveredCase[] };
export type DiscoveryResult = { tests: DiscoveredTest[], warnings: string[] };

type MarkerKind = 'CASE' | 'RANGE' | 'MATRIX';
type Marker = { kind: MarkerKind, args: string[] };
type FoundTest = { name: string, markers: Marker[] };

// A capture group that the pattern's structure guarantees participates in every match.
function captured(match: RegExpMatchArray, group: number): string {
    return match[group] ?? '';
}

export function discoverTests(source: string, options: DiscoveryOptions): DiscoveryResult {
    const warnings: string[] = [];
    const found = findTests(source, options, warnings);
    return { tests: locateTests(source, found), warnings };
}

// ---------------------------------------------------------------------------------------------
// Finding tests: a direct port of find_tests' text processing.

// Unity hides these characters inside string literals so they neither start a comment nor end
// a logical line. It restores them, plus its escaped-quote placeholders, after splitting.
const HIDE_IN_STRINGS: Record<string, string> = { '{': '@co@', '}': '@cc@', ';': '@ss@', '/': '@fs@' };
const UNHIDE: Record<string, string> = { '@co@': '{', '@cc@': '}', '@ss@': ';', '@fs@': '/', '@quote@': '\\"', '@apos@': "\\'" };

// Unity's own sequence: hide escaped quotes and string contents, strip comments, then split at
// preprocessor lines and at `;`, `{`, and `}`. A test signature must then sit within one piece.
function logicalLines(source: string): string[] {
    let text = source.replace(/\\"/g, '@quote@').replace(/\\'/g, '@apos@');
    text = text.replace(/("[^"\n]*")|('[^'\n]*')/g, (literal) => literal.replace(/[{};/]/g, (c) => HIDE_IN_STRINGS[c] ?? c));
    text = stripComments(text, () => '');
    // Splitting on capture groups yields undefined for each group that didn't participate, though
    // the library types the result as string[].
    return text.split(/(^\s*#.*$)|(;|\{|\})/m)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
        .filter((piece): piece is string => piece !== undefined)
        .map((piece) => piece.replace(/@co@|@cc@|@ss@|@fs@|@quote@|@apos@/g, (token) => UNHIDE[token] ?? token));
}

// Unity's three comment passes, in its order. The first removes a line comment that hides the
// start of a block comment, so `// … /*` cannot swallow the code after it.
function stripComments(text: string, replace: (comment: string) => string): string {
    return text
        .replace(/\/\/(?:.+\/\*|\*(?:$|[^/])).*$/gm, replace)
        .replace(/\/\*[\s\S]*?\*\//g, replace)
        .replace(/\/\/.*$/gm, replace);
}

function findTests(source: string, options: DiscoveryOptions, warnings: string[]): FoundTest[] {
    // Ruby's /m is dotall, hence `s`. Group 1 is the marker block, group 2 the name. The name
    // is the prefix plus identifier characters only, so whitespace or a body never joins it.
    const testPattern = new RegExp(
        `^((?:\\s*(?:TEST_(?:CASE|RANGE|MATRIX))\\s*\\(.*?\\)\\s*)*)\\s*void\\s+((?:${options.testPrefix})\\w*)\\s*\\(\\s*(.*)\\s*\\)`,
        'ms',
    );
    const found: FoundTest[] = [];
    const seen = new Set<string>();
    for (const line of logicalLines(source)) {
        const match = testPattern.exec(line);
        if (!match) {
            continue;
        }
        const markerBlock = captured(match, 1);
        const name = captured(match, 2);
        // Unity keeps only the first occurrence of a name, e.g. a prototype before its definition.
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        const markers = options.useParamTests && markerBlock.trim() !== '' ? parseMarkers(name, markerBlock, warnings) : [];
        found.push({ name, markers });
    }
    return found;
}

// Splits a marker block into its markers in source order, expanding each into argument strings.
// Splitting on a capture group yields [prefix, kind, body, kind, body, ...].
function parseMarkers(name: string, markerBlock: string, warnings: string[]): Marker[] {
    const pieces = markerBlock.split(/TEST_(CASE|RANGE|MATRIX)/);
    const markers: Marker[] = [];
    for (let i = 1; i < pieces.length; i += 2) {
        const kind = pieces[i] as MarkerKind;
        const body = pieces[i + 1] ?? '';
        if (kind === 'CASE') {
            // Unity trims inside the parentheses, so `TEST_CASE( 1, 2 )` reports as `(1, 2)`.
            markers.push({ kind, args: [body.replace(/^\s*\(\s*(.*?)\s*\)\s*$/ms, '$1')] });
        } else if (kind === 'RANGE') {
            markers.push({ kind, args: expandRangeMarker(name, body, warnings) });
        } else {
            markers.push({ kind, args: expandMatrixMarker(name, body, warnings) });
        }
    }
    return markers;
}

// `[start, end, step]` includes its end and `<start, end, step>` excludes it. Unity's pattern
// leaves `.` unescaped, so any single character may sit between a value's digits.
const RANGE_PATTERN = /(\[|<)\s*(-?\d+.?\d*)\s*,\s*(-?\d+.?\d*)\s*,\s*(-?\d+.?\d*)\s*(\]|>)/gs;

function expandRangeMarker(name: string, body: string, warnings: string[]): string[] {
    const ranges: string[][] = [];
    for (const match of body.matchAll(RANGE_PATTERN)) {
        const [start, end, step] = [captured(match, 2), captured(match, 3), captured(match, 4)] as const;
        const values = expandRubyRange(start, end, step, captured(match, 1) === '<' && captured(match, 5) === '>');
        if (values === undefined) {
            warnings.push(`TEST_RANGE for ${name} has a zero step (${start}, ${end}, ${step}); Ceedling cannot build this test.`);
            return [];
        }
        ranges.push(values);
    }
    if (ranges.length === 0) {
        warnings.push(`TEST_RANGE for ${name} has no [start, end, step] or <start, end, step> ranges; Ceedling cannot build this test.`);
        return [];
    }
    return cartesianProduct(ranges);
}

// Unity's element pattern: a double-quoted string, a character literal, or a bare token (which
// may contain a bracketed index). Kept as Unity's own source text so the two compare directly.
// eslint-disable-next-line no-useless-escape -- Unity's source escapes `[` inside the class
const MATRIX_ELEMENT = /(?:(?:"(?:\\"|[^\\])*?")+|(?:'\\?.')+|(?:[^\s\]\["',]|\[[\d\S_-]+\])+)/.source;
const MATRIX_LIST_PATTERN = new RegExp(`\\[((?:\\s*${MATRIX_ELEMENT}\\s*,?)*(?:\\s*${MATRIX_ELEMENT})?\\s*)\\]`, 'gs');
const MATRIX_ELEMENT_PATTERN = new RegExp(`\\s*(${MATRIX_ELEMENT})\\s*,\\s*`, 'gs');

function expandMatrixMarker(name: string, body: string, warnings: string[]): string[] {
    // A trailing comma lets every element, the last included, match the comma-terminated pattern.
    const lists = [...body.matchAll(MATRIX_LIST_PATTERN)]
        .map((list) => [...`${captured(list, 1)},`.matchAll(MATRIX_ELEMENT_PATTERN)].map((element) => captured(element, 1)));
    if (lists.length === 0) {
        warnings.push(`TEST_MATRIX for ${name} has no [ ... ] lists; Ceedling cannot build this test.`);
        return [];
    }
    return cartesianProduct(lists);
}

// Every combination of one value per list, first list outermost, each joined as Unity joins it.
// Callers pass at least one list. Unity's generator fails on a marker with none.
function cartesianProduct(lists: string[][]): string[] {
    return lists
        .reduce<string[][]>((combos, list) => combos.flatMap((combo) => list.map((value) => [...combo, value])), [[]])
        .map((combo) => combo.join(', '));
}

// ---------------------------------------------------------------------------------------------
// Ruby number semantics. Unity expands TEST_RANGE with Ruby's Range#step and names each case with
// Float#to_s, so case names follow Ruby's float rules, not JavaScript's.

// Values formatted as Ruby prints them, or undefined for a zero step (Ruby raises). A value
// written with a `.` is a Float, otherwise an Integer, and any Float makes the whole range step
// as floats. A negative step counts down, as Ruby's does.
export function expandRubyRange(start: string, end: string, step: string, excludeEnd: boolean): string[] | undefined {
    const isFloat = [start, end, step].some((value) => value.includes('.'));
    const parse = (value: string) => isFloat ? parseFloat(value) : parseInt(value, 10);
    const [b, e, s] = [parse(start), parse(end), parse(step)] as const;
    if (s === 0) {
        return undefined;
    }
    if (!isFloat) {
        const values: string[] = [];
        const inRange = (v: number) => s > 0 ? (excludeEnd ? v < e : v <= e) : (excludeEnd ? v > e : v >= e);
        for (let v = b; inRange(v); v += s) {
            values.push(String(v));
        }
        return values;
    }
    const count = rubyFloatStepCount(b, e, s, excludeEnd);
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
        // Ruby computes each value from the start, not by accumulation, then clamps the last
        // one to the end so rounding never steps past it.
        let value = i * s + b;
        if (s >= 0 ? e < value : value < e) {
            value = e;
        }
        values.push(rubyFloatToString(value));
    }
    return values;
}

// Port of Ruby's ruby_float_step_size (numeric.c). The error term absorbs float rounding in
// (end - start) / step, so [0, 0.7, 0.1] yields 8 values rather than 7.
function rubyFloatStepCount(start: number, end: number, step: number, excludeEnd: boolean): number {
    let n = (end - start) / step;
    const err = Math.min((Math.abs(start) + Math.abs(end) + Math.abs(end - start)) / Math.abs(step) * Number.EPSILON, 0.5);
    if (excludeEnd) {
        if (n <= 0) {
            return 0;
        }
        n = n < 1 ? 0 : Math.floor(n - err);
        const next = (n + 1) * step + start;
        if ((start < end && next < end) || (start > end && next > end)) {
            n++;
        }
        return n + 1;
    }
    if (n < 0) {
        return 0;
    }
    return Math.floor(n + err) + 1;
}

// Ruby's Float#to_s: the shortest round-trip digits, as JavaScript also produces. It prints fixed
// notation for decimal exponents -4 through 14, always with a fractional part (`1.0`).
// Otherwise it prints `d.ddde±XX`, with at least two exponent digits.
export function rubyFloatToString(value: number): string {
    if (Object.is(value, -0)) {
        return '-0.0';
    }
    // toExponential() always yields `d[.ddd]e±N`, so both parts exist.
    const [mantissa = '', exponentText = '0'] = value.toExponential().split('e');
    const exponent = parseInt(exponentText, 10);
    if (exponent >= -4 && exponent <= 14) {
        const fixed = String(value);
        return fixed.includes('.') ? fixed : `${fixed}.0`;
    }
    const sign = exponent < 0 ? '-' : '+';
    const digits = String(Math.abs(exponent)).padStart(2, '0');
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${sign}${digits}`;
}

// ---------------------------------------------------------------------------------------------
// Locating tests in the original source, for the Testing view's gutter icons and ranges.

// Line positions come from a copy of the source with comments and string contents blanked to
// spaces. It is the same length and keeps every line break, so offsets map straight to lines,
// and commented-out or quoted text can't be mistaken for a test or a marker.
function blankCommentsAndStrings(source: string): string {
    const blank = (text: string) => text.replace(/[^\n]/g, ' ');
    const text = source.replace(/\\["']/g, '  ').replace(/("[^"\n]*")|('[^'\n]*')/g, blank);
    return stripComments(text, blank);
}

function locateTests(source: string, found: FoundTest[]): DiscoveredTest[] {
    const blanked = blankCommentsAndStrings(source);
    const lineStarts = [0, ...[...blanked.matchAll(/\n/g)].map((m) => m.index + 1)];
    // The last line starting at or before `offset`, by binary search over the line starts.
    const lineAt = (offset: number) => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if ((lineStarts[middle] ?? Infinity) <= offset) low = middle; else high = middle - 1;
        }
        return low;
    };

    // Tests are found in source order, so each search starts where the previous one ended.
    let cursor = 0;
    return found.map(({ name, markers }) => {
        const signature = new RegExp(`\\bvoid\\s+${name}\\s*\\(`, 'g');
        signature.lastIndex = cursor;
        const match = signature.exec(blanked);
        if (!match) {
            const line = lineAt(cursor);
            return { name, line, cases: markers.flatMap((m) => m.args.map((args) => ({ args, line }))) };
        }
        const line = lineAt(match.index + match[0].lastIndexOf(name));
        const markerLines = locateMarkers(blanked.slice(cursor, match.index), cursor, markers.length).map(lineAt);
        cursor = match.index + match[0].length;
        return {
            name,
            line,
            cases: markers.flatMap((marker, i) => marker.args.map((args) => ({ args, line: markerLines[i] ?? line }))),
        };
    });
}

// Offsets of the `count` markers directly preceding a signature. They are the last `count`
// markers after the final logical-line boundary (`;`, `{`, `}`, or a preprocessor line) in the
// text between the previous test and this one.
function locateMarkers(between: string, offset: number, count: number): number[] {
    if (count === 0) {
        return [];
    }
    const boundaries = [...between.matchAll(/[;{}]|^[ \t]*#.*$/gm)];
    const last = boundaries[boundaries.length - 1];
    const start = last ? last.index + last[0].length : 0;
    const markers = [...between.slice(start).matchAll(/TEST_(?:CASE|RANGE|MATRIX)\s*\(/g)].map((m) => offset + start + m.index);
    return markers.length === count ? markers : [];
}
