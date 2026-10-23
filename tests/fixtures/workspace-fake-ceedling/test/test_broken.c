#include "unity.h"
#include "calculator.h"

void test_add_should_ReturnSum(void)
{
    int sum = add(1, 2);
    TEST_ASSERT_EQUAL(3, sum);
    sum = add(2, 2)
}
