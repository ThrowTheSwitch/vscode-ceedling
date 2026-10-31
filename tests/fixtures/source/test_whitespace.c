// Test function forms that differ only in whitespace or body layout from `void test_name(void)`.
// Unity's runner generator names each test from its bare identifier, so discovery must too. Its
// captures: the cppunit-report-whitespace.xml reports, ceedling-1.2.2's files-test-stdout.txt and
// files-test-handoff-stdout.txt listings, and the test:all transcripts ceedling-1.2.1/test-stdout.txt
// and ceedling-1.2.2/test-upgrade-stdout.txt, the latter the first build after 1.2.1.
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
