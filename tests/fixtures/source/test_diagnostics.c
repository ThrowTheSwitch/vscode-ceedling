// A test that compiles with a warning, an error, and the notes GCC adds to the error, for the
// problem-matching examples. Its capture is ceedling-1.2.2/compile-diagnostics-stderr.txt.
#include "unity.h"

void setUp(void) {}
void tearDown(void) {}

void test_diagnostics(void)
{
    int unused;
    TEST_ASSERT_EQUAL(1, undeclared);
}
