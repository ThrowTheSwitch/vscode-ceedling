# Upgrade Ceedling

This guide upgrades a project’s Ceedling and brings the extension along. The extension follows each Ceedling version’s features by itself, so an upgrade mostly takes a refresh. An upgrade to Ceedling 1.2.2 also needs one clobber, to remove the old build layout. At the end, the _Testing_ view runs the new Ceedling, with no output left from the old one.

## What you need

- The Ceedling release to upgrade to, 1.0.0 or later. Ceedling 1.0.0 through 1.2.2 are supported.

## Steps

1. **Upgrade Ceedling.** Install the new gem, e.g. with `gem install ceedling`. For a project that vendors its Ceedling in `vendor/ceedling`, also run `ceedling upgrade .` in the project’s directory, which copies the installed Ceedling into it.
2. **Refresh the _Testing_ view** with its refresh button, after a gem upgrade. The extension checks the version again. A changed `vendor/ceedling` refreshes by itself.
3. **Run the tests**, to build them with the new Ceedling.
4. **Clobber, when upgrading to 1.2.2 or later** from an earlier release. See below.

## Upgrading to Ceedling 1.2.2

Ceedling 1.2.2 builds each test in a new place, under its path from the project’s root. An earlier release’s build output stays where it was until a clobber removes it. gcov’s coverage reports still read that output’s counters, so it can skew gcov coverage. Bullseye’s coverage file counts only what runs, so its coverage stays exact.

How the old output goes depends on the release you upgrade from.

- **From 1.2.0 or 1.2.1**, the first build warns about the old layout, and the extension offers to clobber the project. Choose _Clobber_. The clobber waits for the runs under way to finish.
- **From an earlier release**, no warning comes. Clobber once with the _Testing_ view’s Clobber button.

Until the clobber, with [`ceedlingExplorer.coverageResetsCounters`][resets] on, its default, gcov coverage stays exact, since each coverage run clears the counters first. With it off, gcov coverage counts the old layout’s counters too, until the clobber.

## Launch configurations

Launch configurations need no change. The debug token’s path follows each Ceedling version’s own build layout, under the same `build/test/out/` directory. See [Debugging][debugging].

## When something breaks

The [Breaking Changes][breaking] describe the changes that need action when upgrading, and the [Known Issues][known-issues] list the open problems by Ceedling version. [Troubleshooting][troubleshooting] matches each notification to its fix.

[resets]: ../manual/configuration.md#ceedlingexplorercoverageresetscounters
[debugging]: ../manual/debugging.md#the-launch-configuration
[breaking]: https://github.com/ThrowTheSwitch/vscode-ceedling/blob/master/docs/BreakingChanges.md
[known-issues]: https://github.com/ThrowTheSwitch/vscode-ceedling/blob/master/docs/KnownIssues.md
[troubleshooting]: ../troubleshooting.md

<br/><br/>
