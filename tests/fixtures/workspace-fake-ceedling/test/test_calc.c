#include "unity.h"

void test_add(void)
{
}

void test_sub(void)
{
    TEST_ASSERT_EQUAL(1, 2);
}

void test_skip(void)
{
    TEST_IGNORE();
}

TEST_CASE(1)
TEST_CASE(2)
void test_param(int x)
{
    (void)x;
}

void test_add_more(void)
{
}
