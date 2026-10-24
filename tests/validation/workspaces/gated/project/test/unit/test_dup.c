#include "unity.h"
#include "Calculator.h"

void test_unit_add(void)
{
    TEST_ASSERT_EQUAL(3, add(1, 2));
}
