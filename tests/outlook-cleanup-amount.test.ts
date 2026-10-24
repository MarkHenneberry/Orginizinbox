import { expect, it } from "vitest";
import { isOutlookCleanupCount, outlookCleanupSelectionOptions } from "@/lib/domain/outlook-cleanup";

it.each([
  [1, [1]], [2, [1, 2]], [5, [1, 5]], [10, [1, 5, 10]],
  [80, [10, 20, 40, 80]], [300, [30, 75, 150, 300]],
  [500, [50, 125, 250, 500]], [501, [50, 125, 250, 501]],
  [1379, [150, 350, 700, 1379]], [10000, [1000, 2500, 5000, 10000]]
])("rounds %i recommended into useful relative options with the full selection", (total, expected) => {
  const options = outlookCleanupSelectionOptions(total as number);
  expect(options.map(option => option.count)).toEqual(expected);
  expect(options.at(-1)).toMatchObject({ percent: 100, count: total });
  expect(options.at(-1)?.label).toBe(`All recommended (${(total as number).toLocaleString("en-US")})`);
});

it("never offers zeros, duplicates, above-total amounts or invalid totals", () => {
  for (let total = 1; total < 15000; total++) {
    const options = outlookCleanupSelectionOptions(total);
    expect(new Set(options.map(option => option.count)).size).toBe(options.length);
    expect(options.every(option => option.count > 0 && option.count <= total)).toBe(true);
    expect(options.at(-1)?.count).toBe(total);
  }
  for (const total of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(outlookCleanupSelectionOptions(total)).toEqual([]);
    expect(isOutlookCleanupCount(total)).toBe(false);
  }
});

it("omits misleading rounded percentages for tiny selections", () => {
  expect(outlookCleanupSelectionOptions(2)[0].label).toBe("1 message");
  expect(outlookCleanupSelectionOptions(10).find(option => option.count === 5)?.label).toBe("5 messages");
  expect(outlookCleanupSelectionOptions(80)[0].label).toBe("10 messages (~10%)");
});
