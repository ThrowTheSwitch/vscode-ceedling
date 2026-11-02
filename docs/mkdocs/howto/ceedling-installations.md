# Run the Ceedling You Use

This guide points the extension at the Ceedling a project actually uses: in a particular shell, through Bundler, or from another installation. The extension runs `ceedling` in each project’s directory, through the operating system’s default shell, so most installations need nothing. At the end, the extension’s commands run the same Ceedling a terminal does, at the version the project expects.

## What you need

- A Ceedling that runs in a terminal. In the project’s directory, `ceedling version` should print the version you expect.

## Ceedling in a particular shell

Ceedling sometimes runs only in a shell of its own, as is common on Windows with MSYS2 or Git Bash. `ceedlingExplorer.shellPath` names that shell, and every Ceedling command runs in it.

=== "MSYS2"

    <!-- example: settings shell-msys2 -->

    ```json
    {
        "ceedlingExplorer.shellPath": "C:/msys64/usr/bin/bash.exe"
    }
    ```

=== "Git Bash"

    <!-- example: settings shell-git-bash -->

    ```json
    {
        "ceedlingExplorer.shellPath": "C:/Program Files/Git/bin/bash.exe"
    }
    ```

The shell must find Ceedling, and the compiler, on its own `PATH`. The extension runs each command as `<shell> -c "<command>"`, which skips the login setup a terminal’s shell runs. MSYS2’s login setup adds its `bin` directories to `PATH`, for one. Check from a Windows terminal in the project’s directory, the way the extension runs it.

```sh
C:/msys64/usr/bin/bash.exe -c "ceedling version"
```

If that can’t find Ceedling, add the directories holding it and the compiler to the Windows `PATH`, e.g. `C:\msys64\ucrt64\bin` and `C:\msys64\usr\bin`.

## Ceedling through Bundler

A project that pins its Ceedling in a `Gemfile` runs it with `bundle exec`. `ceedlingExplorer.ceedlingCommand` holds the command that runs Ceedling.

<!-- example: settings ceedling-bundler -->

```json
{
    "ceedlingExplorer.ceedlingCommand": "bundle exec ceedling"
}
```

The command runs in each project’s directory, so Bundler finds the `Gemfile` there or above it.

## A Ceedling vendored in the project

A project can carry its own copy of Ceedling in `vendor/ceedling`, as `ceedling new --local` makes. The installed `ceedling`, the launcher, then runs that copy for the project’s commands, and the extension needs no setting. The extension checks the copy’s version, and uses its features. A launcher before 1.2.2 can’t report another build’s release exactly, as the next section explains.

Replacing the copy, e.g. with `ceedling upgrade .`, changes its `vendor/ceedling/lib/version.rb`. The extension notices, and checks the project’s Ceedling again.

## Another installation, by name

Ceedling can run an installation other than the one `ceedling` starts, through the `WHICH_CEEDLING` environment variable or a project’s `:project` ↳ `:which_ceedling` setting. Either one names the installation’s directory, relative to the project’s directory, or `gem` for the installed gem. `WHICH_CEEDLING` outranks the setting, which outranks a `vendor/ceedling` copy.

<!-- example: mixin which-ceedling -->

```yaml
:project:
  :which_ceedling: vendor/ceedling-1.2.2
```

The extension inherits VS Code’s own environment, so `WHICH_CEEDLING` must reach VS Code. Set it in the system’s environment, or in the shell that runs `code`. On macOS and Linux, VS Code also reads the login shell’s environment, so an export in a shell profile works too. Quit VS Code fully, and start it again, after changing the variable.

The launcher must be Ceedling 1.2.2 or later to report the other installation’s release exactly. Earlier launchers can’t tell, so the extension treats the project as the launcher’s own version. With `WHICH_CEEDLING` or a `vendor/ceedling` copy, its log warns about that. With `:which_ceedling` in the project file or a mixin, an earlier launcher never reads the setting, so no warning comes. Everything still works either way, though the _Testing_ view waits for the project’s runs to finish before updating. Installing Ceedling 1.2.2 or later as the gem removes the wait.

## After changing installations

The extension checks each project’s Ceedling when it discovers the project. Some changes rediscover it by themselves, and one doesn’t.

- **A changed `vendor/ceedling`**, `project.yml`, or mixin file rediscovers the folder’s projects.
- **A changed discovery setting**, such as `ceedlingExplorer.ceedlingCommand`, rediscovers them too. Settings that only shape runs, such as `ceedlingExplorer.testCommandArgs`, take effect with the next run.
- **An upgraded gem** needs a refresh. Choose the _Testing_ view’s refresh button, so the extension checks the version again.

[Upgrade Ceedling][upgrade] covers the rest of an upgrade.

[upgrade]: upgrade-ceedling.md

<br/><br/>
