# Fake Ceedling project

The integration tests open this project in VS Code, alongside [`workspace-without-project`](../workspace-without-project). [`tests/integration/main.ts`](../../integration/main.ts) first copies it to a temporary directory. It then points `ceedlingExplorer.ceedlingCommand` at [`fake-ceedling/ceedling.js`](../fake-ceedling/ceedling.js), which answers every Ceedling command from [`fake-ceedling.json`](fake-ceedling.json).

Each test file plays one part:

- `test_calc.c` passes, fails at its assertion's line, is ignored, and has parametrized cases. Ceedling's `--test-case=test_add` filter also selects `test_add_more`, as its substring match does.
- `test_unreported.c` has a test the report leaves out.
- `test_broken.c` fails to compile, with the compiler output captured from Ceedling 1.0.0 in [`ceedling-1.0.0/compile-failure-stderr.txt`](../ceedling-1.0.0/compile-failure-stderr.txt). Its line 9 is where that output places the error.
- `test_slow.c` never finishes, so a run can be cancelled.

The scenario's `gcov` section enables Ceedling's gcov plugin with a Cobertura report. A coverage run of `test_calc.c` covers `src/calc.c`: three lines, one of them a half-taken branch, and the function `add`.
