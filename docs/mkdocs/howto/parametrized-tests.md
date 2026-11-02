# Write Parametrized Tests

This guide sets up Unity’s parametrized tests, which run one test function once per set of arguments. It takes one project setting, and one marker line above each function. At the end, the _Testing_ view lists each case beneath its function, with its own result.

## What you need

- A project the _Testing_ view already lists. See [Start Testing in Your Project][first-run].

## Steps

1. **Enable parametrized tests.** Add the setting below to `project.yml`, or to a [mixin][mixins].
2. **On Ceedling 1.0.0, turn test preprocessing off.** Its preprocessing loses the markers. Set `:project` ↳ `:use_test_preprocessor` to `:none`, its default, or to `:mocks`. Ceedling 1.1.0 and later handle the markers either way.
3. **Mark a test function** with `TEST_CASE()`, `TEST_RANGE()`, or `TEST_MATRIX()`, and give it parameters.
4. **Run it.** Each case appears beneath its function, labeled with its arguments.

<!-- example: mixin param-tests -->

```yaml
:unity:
  :use_param_tests: true
```

## The three markers

Each marker produces cases in its own way, and a function may carry several.

**`TEST_CASE()`** lists one case’s arguments. Repeat it for each case.

```c
TEST_CASE(1, 2, 3)
TEST_CASE(-1, 1, 0)
void test_AddReturnsTheSum(int a, int b, int sum)
{
    TEST_ASSERT_EQUAL(sum, add(a, b));
}
```

The _Testing_ view lists two cases, `1, 2, 3` and `-1, 1, 0`.

**`TEST_RANGE()`** steps each parameter through a range, `[start, end, step]`. Square brackets include the end, and angle brackets, `<start, end, step>`, exclude it. With several ranges, the cases are every combination.

```c
TEST_RANGE([0, 2, 1])
void test_LedIndexIsValid(int index)
{
    TEST_ASSERT_TRUE(led_is_valid(index));
}
```

The view lists three cases, `0`, `1`, and `2`.

**`TEST_MATRIX()`** lists each parameter’s values, and the cases are every combination.

```c
TEST_MATRIX([1, 2], [3, 4])
void test_ProductIsPositive(int a, int b)
{
    TEST_ASSERT_TRUE(a * b > 0);
}
```

The view lists four cases, `1, 3`, `1, 4`, `2, 3`, and `2, 4`.

## Running cases

A case runs with all the other cases of its function, since Ceedling selects tests by function. Every case still reports its own result, and a failed case shows its message at its marker. Debugging a case debugs its whole test file. [Running Tests][running] explains both.

[first-run]: first-run.md
[mixins]: ../manual/configuration.md#mixins
[running]: ../manual/running-tests.md#parametrized-test-cases

<br/><br/>
