def quicksort(arr):
    """快速排序"""
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + middle + quicksort(right)


# 测试用例 1: 随机数组
test1 = [3, 6, 8, 10, 1, 2, 1]
result1 = quicksort(test1)
print(f"测试1: {test1} -> {result1}")
assert result1 == [1, 1, 2, 3, 6, 8, 10], f"测试1失败: {result1}"

# 测试用例 2: 单元素数组
test2 = [5]
result2 = quicksort(test2)
print(f"测试2: {test2} -> {result2}")
assert result2 == [5], f"测试2失败: {result2}"

print("✓ 所有测试通过！")
