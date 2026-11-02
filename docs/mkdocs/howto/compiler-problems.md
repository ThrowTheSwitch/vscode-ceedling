# See Compiler Errors in the Editor

This guide turns on problem matching, so compiler and linker errors appear in the editor and the _Problems_ panel. The built-in `gcc` preset covers GCC, Clang, and the GNU linker, and takes one setting. Custom patterns cover the rest. At the end, a failed build marks each error and warning at its line, with the compiler’s message.

## What you need

- A project the _Testing_ view already lists. See [Start Testing in Your Project][first-run].

## Turn on the gcc preset

The `gcc` preset reads the warnings and errors GCC and Clang report, and the GNU linker’s “undefined reference” errors. Add it to the folder’s `.vscode/settings.json`.

<!-- example: settings problems-gcc -->

```json
{
    "ceedlingExplorer.problemMatching": {
        "mode": "gcc"
    }
}
```

The next failed build’s errors and warnings then appear at their lines. Each build replaces the problems the last build of the same file or project reported, so a fixed error clears with the next build.

Ceedling shows a compiler’s output only when the compiler fails. A file that compiles with warnings and no errors therefore shows no problems, at Ceedling’s default verbosity. The macOS linker’s `Undefined symbols` errors don’t match the preset either, since they name no file and line.

## Add GCC’s notes

The preset leaves out GCC’s `note:` lines, which explain an error, e.g. the macro it came from. A custom pattern can report them at info severity.

Custom patterns replace the preset rather than adding to it, so a configuration that adds notes restates the preset first. Its first three patterns below are the preset’s own. The fourth reads notes.

<!-- example: patterns gcc-with-notes -->

```json
{
    "ceedlingExplorer.problemMatching": {
        "mode": "patterns",
        "patterns": [
            {
                "severity": "warning",
                "filePrefix": "${projectPath}",
                "regexp": "^(.*):(\\d+):(\\d+):\\s+warning:\\s+(.*)$",
                "message": 4, "file": 1, "line": 2, "column": 3
            },
            {
                "severity": "error",
                "filePrefix": "${projectPath}",
                "regexp": "^(.*):(\\d+):(\\d+):\\s+(?:fatal\\s+)?error:\\s+(.*)$",
                "message": 4, "file": 1, "line": 2, "column": 3
            },
            {
                "severity": "error",
                "regexp": "^(.*):(\\d+):(?:\\([^)]*\\):)?\\s+(?!(warning:|error:|note:|fatal error:))(.*)$",
                "message": 4, "file": 1, "line": 2
            },
            {
                "severity": "info",
                "filePrefix": "${projectPath}",
                "regexp": "^(.*):(\\d+):(\\d+):\\s+note:\\s+(.*)$",
                "message": 4, "file": 1, "line": 2, "column": 3
            }
        ]
    }
}
```

Each pattern reads one kind of line.

- **Warnings and errors** read GCC’s `file:line:column: warning: message` form. Group 1 is the file, 2 the line, 3 the column, and 4 the message. `filePrefix` makes the relative file absolute, from the project’s directory.
- **Linker errors** read the GNU linker’s `file:line:(.text+0x18): undefined reference to 'f'` form, with or without the section in parentheses. The linker reports an absolute file, so this pattern needs no `filePrefix`. Its message is group 4. Group 3 sits inside the lookahead that skips the other forms, and never matches.
- **Notes** read the same form as warnings, with `note:`.

## Another compiler

A compiler with its own message format needs a pattern of its own. IAR’s compilers, for example, report `"file",line  Severity[tag]: message`. These two patterns read its warnings and errors.

<!-- example: patterns iar -->

```json
{
    "ceedlingExplorer.problemMatching": {
        "mode": "patterns",
        "patterns": [
            {
                "severity": "warning",
                "filePrefix": "${projectPath}",
                "regexp": "^\"(.*)\",(\\d+)\\s+Warning\\[\\w+\\]:\\s+(.*)$",
                "message": 3, "file": 1, "line": 2
            },
            {
                "severity": "error",
                "filePrefix": "${projectPath}",
                "regexp": "^\"(.*)\",(\\d+)\\s+(?:Fatal )?[Ee]rror\\[\\w+\\]:\\s+(.*)$",
                "message": 3, "file": 1, "line": 2
            }
        ]
    }
}
```

## Write your own

A pattern is a regular expression for one line of the compiler’s output, plus the numbers of its capture groups. Start from a real line, taken from the _Test Results_ panel after a failed build.

1. **Copy a problem line** from the _Test Results_ panel.
2. **Write a regular expression** that matches it, with a group each for the file, the line, and the message. [regex101] helps, with its ECMAScript flavor.
3. **Double each backslash** for JSON, so `\d` becomes `\\d`.
4. **Number the groups** in `file`, `line`, and `message`, plus `column` if the line has one.
5. **Set `filePrefix`** to `${projectPath}` if the compiler reports files relative to the project.

Ceedling reports a failed tool’s output on its own stderr, which patterns scan by default. A pattern for something Ceedling writes to stdout needs `"scanStdout": true`. [Problem Matching][problem-matching] lists every pattern property.

[first-run]: first-run.md
[regex101]: https://regex101.com/
[problem-matching]: ../manual/problem-matching.md

<br/><br/>
