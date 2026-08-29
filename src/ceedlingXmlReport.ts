// Pure, `vscode`-free normalization of a parsed Cppunit-style XML test report (as produced by
// xml2js's `new Parser({ explicitArray: false })` against Ceedling's report_tests_log_factory
// plugin output). Kept free of any `vscode`/`fs` dependency so it can be unit-tested directly in
// plain Node (see tests/unit/ceedlingXmlReport.test.ts).

// Returns the list of <Test> entries under a given category (e.g. "FailedTests",
// "SuccessfulTests", "IgnoredTests") of a parsed <TestRun>. With `explicitArray: false`, a
// category with exactly one Test parses to a single object rather than a one-element array, and
// an empty self-closing category (e.g. `<FailedTests/>`, which Ceedling emits when a run has no
// failures) parses to an empty string - both are normalized here. Throws if xmlReportData doesn't
// have the expected shape; callers are expected to catch and log.
export function getTestListFromXmlReport(xmlReportData: any, testType: string): any[] {
    if (xmlReportData["TestRun"][testType]) {
        if (!(Symbol.iterator in Object(xmlReportData["TestRun"][testType]["Test"]))) {
            xmlReportData["TestRun"][testType]["Test"] = [xmlReportData["TestRun"][testType]["Test"]];
        }
        return xmlReportData["TestRun"][testType]["Test"];
    } else {
        return [];
    }
}
