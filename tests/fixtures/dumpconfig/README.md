# `dumpconfig` fixtures

Real `ceedling dumpconfig` output, captured against a copy of
[`tests/manual`](../../manual), with `report_tests_log_factory` removed from its
`project.yml`. Captured with Ceedling **1.1.8** (a released version within this
extension's supported range).

An earlier capture used a Ceedling 1.2.0 development/prerelease checkout and turned
up custom `!ruby/object:FilenameExtension` tags under `:extension:` that `js-yaml`'s
safe loader refuses to parse. That's an unreleased regression in `dumpconfig`
itself — `configurator_builder.rb`'s `normalize_filename_extensions` wraps every
`:extension:` sub-key in a `FilenameExtension` value object for the build's own use,
and `dump_yaml` dumps that live object graph directly via `YAML.dump` instead of a
plain, portable copy. Confirmed absent on 1.1.8: `:extension:` values are plain
strings there, as expected. Will be fixed upstream before 1.2.0 ships.

- `manual-project-no-report-plugin.yml` — `ceedling dumpconfig` with no `--mixin`.
  `:plugins: :enabled:` has no `report_tests_log_factory`.
- `manual-project-with-bundled-mixin.yml` — the same project, `--mixin
  assets/mixins/report-tests-log-factory.yml` added. `:plugins: :enabled:` now
  includes `report_tests_log_factory`, and `:report_tests_log_factory: :reports:`
  includes `cppunit`. A full `ceedling test:all` with this same mixin was also run by
  hand (Ceedling 1.1.8) against the stripped project and did produce
  `build/artifacts/test/cppunit_tests_report.xml`, confirming the mixin is
  sufficient on its own, with no other change to `project.yml`.
