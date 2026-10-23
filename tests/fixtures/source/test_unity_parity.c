// Test forms that exercise each rule of Unity's runner-generator test discovery
// (auto/generate_test_runner.rb#find_tests): comment stripping, logical-line splitting, string
// literals, TEST_CASE/TEST_RANGE/TEST_MATRIX expansion, number formatting, and deduplication.
// See the cppunit-report-unity-parity.xml fixtures, captured by running this file through real
// Ceedling with :unity: :use_param_tests: true.
#include "unity.h"
#include <string.h>

void setUp(void) {}
void tearDown(void) {}

/*
void test_InBlockComment(void)
{
}
*/

// void test_InLineComment(void) {}

// A line comment that hides the start of a block comment: /*
void test_AfterTrickyComment(void)
{
}

static void test_StaticIsNotATest(void)
{
}

void should_UseShouldPrefix(void)
{
}

void spec_UseSpecPrefix(void)
{
}

void test_Prototyped(void);

void test_Prototyped(void)
{
}

TEST_CASE("a;b{c}")
TEST_CASE("//not a comment")
void test_StringCaseArgs(const char* s)
{
    TEST_ASSERT_NOT_NULL(s);
}

TEST_CASE(1)

// A comment between parametrized markers.
TEST_CASE(2)
void test_CommentBetweenCases(int x)
{
    TEST_ASSERT_TRUE(x > 0);
}

TEST_RANGE(<0, 3, 1>)
void test_ExclusiveRange(int x)
{
    TEST_ASSERT_TRUE(x < 3);
}

TEST_RANGE([0.0, 1.0, 0.5])
void test_FloatRange(float f)
{
    TEST_ASSERT_TRUE(f >= 0.0f);
}

TEST_RANGE([0, 0.7, 0.1])
void test_FloatRangeAccumulates(float f)
{
    TEST_ASSERT_TRUE(f >= 0.0f);
}

TEST_RANGE([0, 2.0, 1])
void test_MixedIntFloatRange(float f)
{
    TEST_ASSERT_TRUE(f >= 0.0f);
}

TEST_RANGE([0, 1, 1], [5, 6, 1])
void test_TwoRangesProduct(int a, int b)
{
    TEST_ASSERT_TRUE(b > a);
}

TEST_CASE(9, 9)
TEST_RANGE([1, 2, 1], [7, 7, 1])
void test_CaseAndRangeMixed(int a, int b)
{
    TEST_ASSERT_TRUE(a > 0 && b > 0);
}

TEST_MATRIX([1, 2], [3, 4])
void test_Matrix(int a, int b)
{
    TEST_ASSERT_TRUE(b > a);
}

TEST_MATRIX(["x", "y"], [10, -20])
void test_MatrixStringsAndInts(const char* s, int n)
{
    TEST_ASSERT_EQUAL(1, strlen(s));
    TEST_ASSERT_NOT_EQUAL(0, n);
}
