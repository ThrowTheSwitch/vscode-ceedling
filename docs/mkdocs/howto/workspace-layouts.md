# Work With Several Projects

This guide sets up workspaces that hold Ceedling projects somewhere other than the folder’s root, or more than one of them. Each layout below takes one setting, `ceedlingExplorer.projects`, in the folder’s `.vscode/settings.json`. At the end, the _Testing_ view lists each project, and runs, debugs, and measures each one with its own configuration.

## What you need

- Ceedling projects the extension can run. See [Start Testing in Your Project][first-run].

## A project in a subdirectory

A project file outside the folder’s root needs the project’s directory in `path`. Paths are relative to the workspace folder.

<!-- example: settings layout-subdirectory -->

```json
{
    "ceedlingExplorer.projects": [
        { "path": "firmware" }
    ]
}
```

## Several projects in one folder

A folder holding several projects lists each one. The _Testing_ view then shows each project by its `name`, with its test files beneath it. Each project can name its own launch configuration and mixins.

<!-- example: settings layout-monorepo -->

```json
{
    "ceedlingExplorer.mixins": ["mixins/common.yml"],
    "ceedlingExplorer.projects": [
        { "path": "app", "name": "Application", "debugLaunchConfig": "Debug app test" },
        { "path": "bootloader", "name": "Bootloader", "mixins": ["gcc", "mixins/bootloader.yml"] },
        { "path": "tools/codec", "name": "Codec", "mixins": [] }
    ]
}
```

The three projects take their mixins three ways.

- **Application** names no mixins, so it takes `ceedlingExplorer.mixins`. The mixin’s path is relative to the project’s own directory, so it is `app/mixins/common.yml`.
- **Bootloader** names its own, which replace the folder’s list. `gcc` is one of Ceedling’s built-in toolchain targets, from Ceedling 1.1.0, named without a path.
- **Codec** names an empty list, so it takes no mixins at all.

## Several workspace folders

A multi-root workspace lists each folder’s projects under an entry of its own, labeled _Ceedling (folder)_. Each folder reads its own `.vscode/settings.json`, so each can describe its projects differently.

<!-- example: workspace layout-multi-root -->

```json
{
    "folders": [
        { "path": "product" },
        { "path": "shared-libraries" }
    ]
}
```

The `.code-workspace` file above lists the folders. Each folder’s own settings file then names its projects, e.g. `shared-libraries/.vscode/settings.json`.

<!-- example: settings layout-multi-root-folder -->

```json
{
    "ceedlingExplorer.projects": [
        { "path": "ring-buffer" },
        { "path": "crc" }
    ]
}
```

A folder without a Ceedling project adds no entry.

## A project file of your own

A `path` can name a YAML file instead of a directory. A file named `project.yml` is the project itself. Any other file is applied as a mixin over the `project.yml` beside it. That suits a variant of a project, e.g. one for CI or a simulator, kept beside the main file.

<!-- example: settings layout-project-file -->

```json
{
    "ceedlingExplorer.projects": [
        { "path": "firmware/project.yml", "name": "Firmware" },
        { "path": "firmware/simulator.yml", "name": "Firmware on the simulator" }
    ]
}
```

From Ceedling 1.2.0, a directory may hold `ceedling.yml` in place of `project.yml`. The extension finds either one. A directory holding both is an error, as Ceedling itself reports it. Name the one to use in `path` to settle it.

## Same-named test files

Two test files may share a name in different directories, e.g. `test/unit/test_buffer.c` and `test/integration/test_buffer.c`. What works depends on the Ceedling version.

| Ceedling | Runs and results | Debugging | Coverage |
|---|---|---|---|
| 1.2.2 and later | Each file apart | Each file apart | Each file apart |
| 1.2.1 | Each file apart, with one exception | Each file apart, with one exception | Each file apart, with one exception |
| 1.2.0 | Each file apart, with one exception | Each file apart, with one exception | Fails with an ambiguous file reference |
| Before 1.2.0 | May run the other file | May debug the other file | May run the other file |

Ceedling 1.2.0 and later tell the files apart by their paths, and so does the extension. Before that, Ceedling names a test file by its name alone. The extension’s log warns when a coverage run can’t tell the files apart.

Ceedling 1.2.0 and 1.2.1 make one exception. They can’t build a test file whose path within the test path ends another same-named file’s path, e.g. `test/test_calc.c` beside `test/unit/test_calc.c`. Ceedling 1.2.2 builds both. The [Known Issues][known-issues] describe it.

[first-run]: first-run.md
[known-issues]: https://github.com/ThrowTheSwitch/vscode-ceedling/blob/master/docs/KnownIssues.md

<br/><br/>
