# Configuration

This page is the reference for every setting and command the extension contributes. Most projects need none of them. The [How-To guides][howto] show the settings at work in complete examples.

## Settings

The extension’s settings live under `ceedlingExplorer` in VS Code’s settings. Set them in a workspace’s or a folder’s `.vscode/settings.json` to suit one project, or in your user settings to suit them all. VS Code’s _Settings_ editor lists them too, under _Extensions_ ↳ _Ceedling project configuration_.

Each setting below gives its default. A setting left unset takes its default.

### `ceedlingExplorer.projects`

Default: `[]`

The Ceedling projects in the workspace folder, one entry each. With none, the folder itself is the project, with its `project.yml` at the folder’s root. From Ceedling 1.2.0, `ceedling.yml` works there too. [Getting Started][opening] explains when a project needs an entry.

```json
"ceedlingExplorer.projects": [
    {
        "path": "firmware",
        "name": "Firmware",
        "debugLaunchConfig": "Debug firmware test"
    }
]
```

Each entry has four fields.

- `path` names the project, relative to the workspace folder. It is required. It is either a directory holding a `project.yml`, or a YAML file, `.yml` or `.yaml`. A YAML file other than `project.yml` is applied as a mixin over the `project.yml` beside it. With Ceedling 1.2.0 and later, `ceedling.yml` works in place of `project.yml`, but a directory may not hold both.
- `name` labels the project in the _Testing_ view, which lists projects by name when a folder holds several. Without it, the label is the path. A YAML file other than `project.yml` gives its file name, without the extension. Each label must be unique, since a later entry with the same one replaces the earlier.
- `debugLaunchConfig` is the *name* of the `launch.json` configuration that debugs the project’s tests. Without it, the project debugs with a configuration named `ceedling`. See [Debugging][debugging].
- `mixins` are the project’s own [mixins][mixins], lowest to highest priority. Without them, the project uses `ceedlingExplorer.mixins`. An explicit `[]` opts the project out of that workspace-wide list.

Without any entry, the extension also expects a debug configuration named `ceedling`.

### `ceedlingExplorer.mixins`

Default: `[]`

The [mixins][mixins] applied to every project that doesn’t name its own, lowest to highest priority. Each entry is one of three things. A name, without a path or extension, is a mixin Ceedling finds through its mixin load paths. Ceedling’s built-in toolchain targets, such as `gcc` or `clang`, are named this way. A path names a YAML file, relative to the project’s directory.

```json
"ceedlingExplorer.mixins": ["gcc", "mixins/coverage.yml"]
```

### `ceedlingExplorer.shellPath`

Default: `null`

The path to the shell Ceedling runs in. With `null`, Ceedling runs in the operating system’s default shell. Set it when Ceedling runs only in a particular shell, as is common on Windows with MSYS2 or Git Bash. [Getting Started][runs-ceedling] explains how the extension runs Ceedling.

```json
"ceedlingExplorer.shellPath": "C:/msys64/usr/bin/bash.exe"
```

### `ceedlingExplorer.ceedlingCommand`

Default: `"ceedling"`

The command that runs Ceedling. Set it to run Ceedling through Bundler, or from a path of its own. [Getting Started][runs-ceedling] explains how the extension runs Ceedling.

```json
"ceedlingExplorer.ceedlingCommand": "bundle exec ceedling"
```

### `ceedlingExplorer.testCommandArgs`

Default: `["test:${TEST_ID}"]`

The arguments that run one test file. Their `${TEST_ID}` tag becomes the test file, or `all` when a run covers a whole project. With Ceedling 1.2.0 and later, the test file is its project-relative path, e.g. `test/unit/test_foo.c`, which tells same-named test files apart. With earlier versions, it is the file’s name alone. Coverage runs use [`ceedlingExplorer.coverageCommandArgs`][coverage-args] instead. [Running Tests][run-tasks] explains which task each run calls.

### `ceedlingExplorer.coverageCommandArgs`

Default: `["gcov:${TEST_ID}"]`

The arguments that run one test file with [coverage][coverage]. Their `${TEST_ID}` tag becomes the test file, or `all` when a run covers a whole project. With Ceedling 1.2.1 and later, the test file is its project-relative path, as for `testCommandArgs`. With earlier versions, it is the file’s name alone, as their `gcov:` tasks require.

### `ceedlingExplorer.coverageResetsCounters`

Default: `true`

Whether each coverage run first clears the coverage counters earlier runs left, so it shows only what it executed. Set it to `false` to accumulate coverage across runs instead, as Ceedling itself does until a `clean` or `clobber`. [Code Coverage][coverage] explains how coverage runs work.

### `ceedlingExplorer.prettyTestLabel`

Default: `true`

Shortens each test’s label in the _Testing_ view by dropping its prefix. For example, `test_BlinkTaskShouldToggleLed` becomes `BlinkTaskShouldToggleLed`. [Running Tests][labels] shows both forms.

### `ceedlingExplorer.prettyTestFileLabel`

Default: `true`

Shortens each test file’s label by dropping its path, prefix, and extension. For example, `test/LEDs/test_BlinkTask.c` becomes `BlinkTask`. [Running Tests][labels] shows both forms.

### `ceedlingExplorer.problemMatching`

Default: none. Its `mode` field defaults to `"disabled"`, and its `patterns` field to `[]`.

Reports compiler and linker problems in the editor and the _Problems_ panel. Problem matching is off until `mode` selects a preset or custom `patterns`.

```json
"ceedlingExplorer.problemMatching": {
    "mode": "gcc"
}
```

[Problem Matching][problem-matching] explains both fields and every pattern property.

### `ceedlingExplorer.ansiEscapeSequencesRemoved`

Default: `true`

Whether ANSI escape sequences, such as terminal colors, are removed from Ceedling’s output before the extension reads it and shows it. [Getting Started][runs-ceedling] explains how the extension runs Ceedling.

## Mixins

A [Ceedling mixin][mixins-docs] is a YAML fragment merged into a project’s configuration at build time. Mixins suit toolchain targets, CI overrides, and configuration that shouldn’t be copied into every `project.yml`.

Two settings configure them. `ceedlingExplorer.mixins` applies to every project, and `ceedlingExplorer.projects[].mixins` replaces it for one project. Later entries win on conflicts, matching the precedence of Ceedling’s own `--mixin` option. The extension passes them to the Ceedling commands it runs for a project, from the `ceedling dumpconfig` that reads its configuration to each test run.

The extension always applies one more mixin, after any you configure. It enables the `report_tests_log_factory` plugin’s `cppunit` report, which is where the _Testing_ view reads results. This mixin always takes the highest priority, so no project file or mixin can turn the report off. Only an invalid mixin keeps it from applying, and discovery then stops with an error. Enabling `report_tests_log_factory` yourself as well is harmless.

The extension warns once if the CppUnit report has a name other than its default. That happens when `project.yml` or a mixin sets `:report_tests_log_factory` ↳ `:cppunit` ↳ `:filename`. The extension still finds the report. The warning only points out the unusual name, in case it wasn’t intended.

## Commands

Two commands run Ceedling’s cleanup tasks in every Ceedling project in the workspace. They appear in the Command Palette and as buttons in the _Testing_ view’s toolbar. Each project’s command waits for any Ceedling build under way in that project to finish.

| ID | Command | Runs |
|---|---|---|
| `ceedlingExplorer.clean` | _Ceedling: Clean_ | `ceedling clean` |
| `ceedlingExplorer.clobber` | _Ceedling: Clobber_ | `ceedling clobber` |

Bind a keyboard shortcut to either by its ID. Running, debugging, and refreshing tests use VS Code’s own _Testing_ commands.

[howto]: ../howto/index.md
[debugging]: debugging.md
[coverage]: code-coverage.md#how-coverage-runs-work
[opening]: getting-started.md#opening-a-project
[runs-ceedling]: getting-started.md#how-the-extension-runs-ceedling
[run-tasks]: running-tests.md#how-a-run-calls-ceedling
[labels]: running-tests.md#test-labels
[mixins]: #mixins
[coverage-args]: #ceedlingexplorercoveragecommandargs
[problem-matching]: problem-matching.md
[mixins-docs]: https://docs.throwtheswitch.org/Ceedling/latest/configuration/mixins/

<br/><br/>
