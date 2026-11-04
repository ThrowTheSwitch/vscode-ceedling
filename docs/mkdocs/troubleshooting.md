# Troubleshooting

Most problems show up as a notification, and the extension’s log says more. This page matches each common symptom and message to its cause and fix. When nothing here fits, check the [Known Issues][known-issues] before [filing a bug report][issues].

## Reading the extension’s log

The extension logs each problem it finds to the _Ceedling Explorer_ output channel. Open the _Output_ panel and choose _Ceedling Explorer_ from its list.

The log shows information, warnings, and errors by default. Raise the channel’s level to _Debug_ to also see every Ceedling command the extension runs, with its working directory and shell. Use the _Output_ panel’s gear menu, or the _Developer: Set Log Level…_ command. A bug report with a debug-level log is far easier to act on.

## No tests appear

A project that can’t be discovered leaves its whole workspace folder without tests until the problem is fixed. A notification names the problem. Each message below is the start of one.

- **“Could not run 'ceedling version' for project …”** Ceedling isn’t installed, or isn’t on the `PATH` of the shell the extension uses. Check that `ceedling version` works in a terminal. Set [`ceedlingExplorer.shellPath`][shell-path] to the shell where it does, or [`ceedlingExplorer.ceedlingCommand`][command] to the command that runs it.
- **“Ceedling version … is not supported.”** The project runs a Ceedling older than 1.0.0. Upgrade Ceedling, or the copy in the project’s `vendor/ceedling`.
- **“Ceedling stopped reporting its version for project …”** Ceedling itself stopped with an error, which the message quotes. A project file, a mixin, or a `:project` ↳ `:which_ceedling` that names a missing installation usually causes it.
- **“Failed to resolve Ceedling's configuration for project …”** `ceedling dumpconfig` failed, and the message quotes Ceedling’s error. Check that the paths in [`ceedlingExplorer.projects`][projects] and every mixin exist.
- **“Failed to list the test files of Ceedling project …”** `ceedling files:test` failed. Check the project’s `:paths:` ↳ `:test:` entries.
- **“The project path … does not exist or is not a directory.”** A `ceedlingExplorer.projects[].path` names nothing. Paths are relative to the workspace folder.
- **“Both project.yml and ceedling.yml exist in …”** Ceedling can’t tell which file is the project. Remove or rename one, or name the one to use in `ceedlingExplorer.projects[].path`.
- **“ceedlingExplorer.… must be …”** A setting holds the wrong kind of value, e.g. a single string where a list belongs. Fix it in `settings.json`.
- **“The required Ceedling plugin 'report_tests_log_factory' did not take effect …”** A configured mixin is invalid, so the extension’s own mixin didn’t apply. Check `ceedlingExplorer.mixins` and each `projects[].mixins`.
- **“Failed to load Ceedling project: …”** Discovery failed unexpectedly. Please [report it][issues], with the log’s copy of the message.

A project the extension can’t find shows no notification at all. That happens when the project file isn’t at the workspace folder’s root, or when a `ceedlingExplorer.projects[].path` names a directory or YAML file without a project file to go with it. Name the project’s path in [`ceedlingExplorer.projects`][projects].

## A run shows no results

A build that fails marks each of its tests errored, with the build’s error. The _Test Results_ panel shows Ceedling’s output, with the compiler or linker error in full. [Problem matching][problem-matching] can also put those errors in the editor.

A test marked errored with “Ceedling reported no result for this test” ran in a build that reported others. Usually the test list is stale. Refresh the _Testing_ view. The log then shows “Ceedling reported results matching no discovered test” for any results the extension couldn’t place.

## Debugging doesn’t start

Each debugging message names what to fix.

- **“Start debugging from a test’s debug icon in the Testing view …”** The configuration was started with F5 or from the _Run and Debug_ view. Only a test’s debug button supplies the test executable. See [Debugging][debugging].
- **“No debug configuration named '…' found in launch.json.”** The project’s `debugLaunchConfig` doesn’t match any configuration’s `"name"`. A project that names none needs a configuration named `ceedling`.
- **“The debugger could not be started with '…'.”** VS Code rejected the configuration. Check that its `type` names an installed debugger extension, and that its debugger’s path exists.

## Coverage shows nothing

A coverage run that shows no coverage says why. Each reason is notified once a session, and every run logs it and notes it in the _Test Results_ panel. [Code Coverage][no-coverage] lists each reason and its fix.

## After a Ceedling upgrade

Upgrading the installed Ceedling gem needs a refresh of the _Testing_ view, so the extension checks the version again. A change to a project’s `vendor/ceedling` refreshes it by itself.

From Ceedling 1.2.2, each test builds in a new place. After an upgrade from 1.2.0 or 1.2.1, the extension offers to clobber the project’s old build output. After an upgrade from an earlier release, clobber once with the _Testing_ view’s Clobber button.

A log warning that a project “runs Ceedling … from another installation” means its launcher can’t tell the other installation’s release. Launchers before 1.2.2 can’t ([Ceedling#1365][ceedling-1365]). Everything still works, though discovery waits for runs to finish. Upgrading the installed Ceedling to 1.2.2 or later removes the warning.

## Clean or Clobber fails

A notification that “Ceedling clean failed” or “Ceedling clobber failed” means the command failed in at least one project. Run the same command, `ceedling clean` or `ceedling clobber`, in a terminal in the project’s directory to see Ceedling’s error.

## Known issues and bug reports

Open problems are listed by Ceedling version in the [Known Issues][known-issues]. If yours isn’t there, please [file a bug report][issues], with the extension’s version, your Ceedling version, and a debug-level log.

[known-issues]: https://github.com/ThrowTheSwitch/vscode-ceedling/blob/master/docs/KnownIssues.md
[issues]: https://github.com/ThrowTheSwitch/vscode-ceedling/issues
[shell-path]: manual/configuration.md#ceedlingexplorershellpath
[command]: manual/configuration.md#ceedlingexplorerceedlingcommand
[projects]: manual/configuration.md#ceedlingexplorerprojects
[problem-matching]: manual/problem-matching.md
[debugging]: manual/debugging.md
[no-coverage]: manual/code-coverage/index.md#when-no-coverage-appears
[ceedling-1365]: https://github.com/ThrowTheSwitch/Ceedling/issues/1365

<br/><br/>
