#include "unity.h"
#include "Calculator.h"

void setUp(void) {}
void tearDown(void) {}

void test_add_should_ReturnSum(void) {
    TEST_ASSERT_EQUAL(5, add(2, 3));
}

void test_add_should_ReturnSumButIsDeliberatelyWrong(void) {
    TEST_ASSERT_EQUAL(1, add(2, 3));
}

void test_should_BeIgnored(void) {
    TEST_IGNORE_MESSAGE("not implemented yet");
}
