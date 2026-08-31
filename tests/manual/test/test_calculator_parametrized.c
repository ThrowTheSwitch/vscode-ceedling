// Requires Ceedling 1.1.0 or later. Ceedling 1.0.0 has no TEST_CASE support at all, so this file
// is kept separate from test_calculator.c - a build failure here should not take down the tests
// that do work on 1.0.0.
//
// Even on 1.1.0, this can still fail to build with GCC 14 or later. Ceedling's generated runner
// assigns a typed function pointer without a cast, which older GCC only warns about but GCC 14
// treats as an error. This is a real Ceedling code-generation bug, not something fixable here.
// See tests/manual/README.md.
#include "unity.h"
#include "Calculator.h"

void setUp(void) {}
void tearDown(void) {}

TEST_CASE(2, 3, 5)
TEST_CASE(10, -4, 6)
void test_add_ParameterizedCases(int a, int b, int expected) {
    TEST_ASSERT_EQUAL(expected, add(a, b));
}
