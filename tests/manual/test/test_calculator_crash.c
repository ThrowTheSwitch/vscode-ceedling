#include "unity.h"
#include "Calculator.h"

void setUp(void) {}
void tearDown(void) {}

// Kept in its own file, apart from test_calculator.c's ignored test. Ceedling's :use_backtrace
// re-runs every test in a crashed file individually to identify the crash. A known Ceedling bug
// (fixed in 1.1.7/1.2.0) can misclassify an ignored test as crashed when it shares a file with a
// real crash - a separate file avoids exercising that unrelated bug here.
void test_add_should_ReturnSum(void) {
    TEST_ASSERT_EQUAL(5, add(2, 3));
}

// Deliberately dereferences a null pointer. Exercises Ceedling's :use_backtrace crash handling
// (see project.yml). Ceedling catches the crash, reruns this test case in isolation to identify
// it, and reports it as a normal failed test at the exact crashing line, instead of the whole
// executable just hanging or the test run silently stopping.
void test_should_crash(void) {
    int *p = NULL;
    *p = 42;
}
