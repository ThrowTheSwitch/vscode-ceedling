# How-To

These guides walk through common needs step by step. Each one lists requirements and provides complete examples. The [User Manual][manual] explains every feature and setting they use.

<div class="grid cards" markdown>

-   :material-rocket-launch: **[Start Testing in Your Project][first-run]**

    ---

    Install the extension, open a project, and run its first test. Most projects need no configuration.

-   :material-bug-play: **[Debug a Test][debug]**

    ---

    A launch configuration for Linux, macOS, or Windows, so any test runs under the debugger from its debug button.

-   :material-chart-donut: **[Measure Code Coverage][coverage]**

    ---

    A code coverage plugin mixin with Gcovr, ReportGenerator, or Bullseye, so _Run with Coverage_ shows each line’s hits.

-   :material-alert-circle: **[See Compiler Errors in the Editor][problems]**

    ---

    The `gcc` preset, or patterns of your own, so build errors appear at their lines and in the _Problems_ panel.

-   :material-folder-multiple: **[Work With Several Projects][layouts]**

    ---

    Projects in subdirectories, several projects in one folder, multi-root workspaces, and project files of your own.

-   :material-console: **[Run the Ceedling You Use][installations]**

    ---

    Ceedling in a particular shell, through Bundler, vendored in the project, or selected by name.

-   :material-update: **[Upgrade Ceedling][upgrade]**

    ---

    A new Ceedling release, picked up with a refresh, and the old build layout cleaned out.

-   :material-table: **[Write Parametrized Tests][param]**

    ---

    Unity’s `TEST_CASE()`, `TEST_RANGE()`, and `TEST_MATRIX()`, with each case listed and reported apart.

-   :material-flash-alert: **[Find a Crashing Test][crash]**

    ---

    Ceedling’s `:use_backtrace`, so a crash reports as a failure at the test that crashed.

-   :material-target: **[Run Just One Test][single]**

    ---

    A single test function, run without the rest of its file, and what Ceedling still builds. A section of the User Manual.

</div>

[manual]: ../manual/index.md
[first-run]: first-run.md
[debug]: debug-a-test.md
[coverage]: code-coverage.md
[problems]: compiler-problems.md
[layouts]: workspace-layouts.md
[installations]: ceedling-installations.md
[upgrade]: upgrade-ceedling.md
[param]: parametrized-tests.md
[crash]: crashing-tests.md
[single]: ../manual/running-tests.md#a-single-test

<br/><br/>
