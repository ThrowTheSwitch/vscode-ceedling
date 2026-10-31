// Test function forms that differ only in whitespace or body layout from the conventional
// `void test_name(void)` signature. Unity's runner generator names each test from its bare
// identifier, so discovery must too. See the cppunit-report-whitespace.xml fixtures, captured by
// running this file through real Ceedling. ceedling-1.2.2/files-test-stdout.txt and
// files-test-handoff-stdout.txt list it.
#include "unity.h"

void setUp(void) {}
void tearDown(void) {}

void test_SpaceBeforeParen (void)
{
    TEST_ASSERT_TRUE(1);
}

void test_TabAndNewlineBeforeParen	(
    void)
{
    TEST_ASSERT_TRUE(1);
}

void test_OneLineBody(void) { TEST_ASSERT_EQUAL(2, (1 + 1)); }

TEST_CASE( 2, 3, 5 )
TEST_CASE(10, -4, 6)
void test_PaddedParamArgs (int a, int b, int expected)
{
    TEST_ASSERT_EQUAL(expected, a + b);
}
