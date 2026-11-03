# Reference

This page lists every setting and command the extension contributes, grouped by purpose. Each name links to its full entry in the User Manual, with its default and examples.

!!! note
    Every setting’s fully qualified name begins with `ceedlingExplorer.`. As an example, `projects` below is `ceedlingExplorer.projects` in `settings.json`. Command IDs begin with the same slug.

## Projects

- [`mixins`][mixins] — Ceedling mixins for every project without its own
- [`projects`][projects] — The Ceedling projects in a workspace folder
    - [`debugLaunchConfig`][projects] — The `launch.json` configuration that debugs the project
    - [`mixins`][projects] — The project’s own mixins, in place of `mixins` above
    - [`name`][projects] — The project’s label in the _Testing_ view
    - [`path`][projects] — The project’s directory or YAML file

## Running Ceedling

- [`ansiEscapeSequencesRemoved`][ansi] — Remove terminal colors from Ceedling’s output
- [`ceedlingCommand`][command] — The command that runs Ceedling
- [`shellPath`][shell-path] — The shell Ceedling runs in
- [`testCommandArgs`][test-args] — Ceedling’s arguments for a test run

## Test labels

- [`prettyTestFileLabel`][pretty-file] — Shorten each test file’s label
- [`prettyTestLabel`][pretty-test] — Shorten each test’s label

## Code coverage

- [`coverageCommandArgs`][coverage-args] — Ceedling’s arguments for a coverage run
- [`coverageResetsCounters`][resets] — Clear coverage counters before each coverage run

## Problem matching

- [`problemMatching`][problem-matching] — Report compiler and linker problems in the editor
    - [`mode`][fields] — Off, the `gcc` preset, or custom patterns
    - [`patterns`][fields] — The custom patterns

### Pattern properties

Each custom pattern in `problemMatching.patterns` is an object with these properties. Only `regexp`, `message`, and `file` are required.

- [`column`][pattern] — The capture group holding the first column
- [`file`][pattern] — The capture group holding the file
- [`filePrefix`][pattern] — Prepended to a relative file path
- [`lastColumn`][pattern] — The capture group holding the last column
- [`lastLine`][pattern] — The capture group holding the last line
- [`line`][pattern] — The capture group holding the first line
- [`message`][pattern] — The capture group holding the message
- [`regexp`][pattern] — The regular expression matching a problem line
- [`scanStderr`][pattern] — Scan Ceedling’s stderr
- [`scanStdout`][pattern] — Scan Ceedling’s stdout
- [`severity`][pattern] — The severity of the problems found

## Commands

- [`clean`][commands] — Run `ceedling clean` in every project
- [`clobber`][commands] — Run `ceedling clobber` in every project

[mixins]: manual/configuration.md#ceedlingexplorermixins
[projects]: manual/configuration.md#ceedlingexplorerprojects
[ansi]: manual/configuration.md#ceedlingexploreransiescapesequencesremoved
[command]: manual/configuration.md#ceedlingexplorerceedlingcommand
[shell-path]: manual/configuration.md#ceedlingexplorershellpath
[test-args]: manual/configuration.md#ceedlingexplorertestcommandargs
[pretty-file]: manual/configuration.md#ceedlingexplorerprettytestfilelabel
[pretty-test]: manual/configuration.md#ceedlingexplorerprettytestlabel
[coverage-args]: manual/configuration.md#ceedlingexplorercoveragecommandargs
[resets]: manual/configuration.md#ceedlingexplorercoverageresetscounters
[problem-matching]: manual/configuration.md#ceedlingexplorerproblemmatching
[fields]: manual/problem-matching.md#the-settings-fields
[pattern]: manual/problem-matching.md#pattern-properties
[commands]: manual/configuration.md#commands

<br/><br/>
