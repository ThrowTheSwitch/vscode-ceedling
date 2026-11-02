// A test calling a function that no source defines, so the link fails, for the problem-matching
// examples. Its capture is ceedling-1.2.2/link-failure-stderr.txt.
#include "unity.h"
#include "unlinked.h"

void setUp(void) {}
void tearDown(void) {}

void test_unlinked(void)
{
    TEST_ASSERT_EQUAL(1, unlinked(1));
}
