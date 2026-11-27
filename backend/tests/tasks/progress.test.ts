import assert from "node:assert/strict";
import { test } from "node:test";
import { toProgress } from "../../task-service/services/progress";

const cases: [unknown, unknown, number][] = [
  [0, 0, 0], // not NaN
  [3, 1, 33],
  [3, 2, 67], // same rounding as the Feature 10 dashboard
  [4, 4, 100],
  [8, 1, 13],
  ["36", "24", 67], // strings, as MySQL returns COUNT/SUM
  [null, null, 0],
];

for (const [total, completed, percentComplete] of cases) {
  test(`${String(completed)} of ${String(total)} done is ${percentComplete}%`, () => {
    assert.equal(toProgress(total, completed).percentComplete, percentComplete);
  });
}

test("open is total minus completed, and counts are numbers", () => {
  assert.deepEqual(toProgress("36", "24"), { total: 36, completed: 24, open: 12, percentComplete: 67 });
  assert.deepEqual(toProgress(0, 0), { total: 0, completed: 0, open: 0, percentComplete: 0 });
});
