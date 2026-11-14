import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/events/utils/budgetPreview.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { allocateBudget } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const categories = values => values.map((defaultPercentage, index) => ({ templateCategoryId: String(index), defaultPercentage }));

test('allocates ordinary and zero budgets', () => {
  assert.deepEqual(allocateBudget('10000.00', categories(['42.00', '58.00'])), [420000, 580000]);
  assert.deepEqual(allocateBudget('0', categories(['42', '58'])), [0, 0]);
});
test('reconciles fractional cents deterministically', () => {
  assert.deepEqual(allocateBudget('0.01', categories(['33.33', '33.33', '33.34'])), [0, 0, 1]);
  assert.deepEqual(allocateBudget('0.01', categories(['50', '50'])), [1, 0]);
  assert.deepEqual(allocateBudget('10.01', categories(['50', '50'])), [501, 500]);
});
test('supports DECIMAL(12,2) maximum without losing cents', () => {
  const result = allocateBudget('9999999999.99', categories(['33.33', '33.33', '33.34']));
  assert.equal(result.reduce((sum, amount) => sum + amount, 0), 999999999999);
});
test('rejects invalid budgets and incomplete or invalid defaults', () => {
  for (const total of ['', '-1', '1.001', '1e3', 'NaN', '10000000000', '1,000']) {
    assert.equal(allocateBudget(total, categories(['100'])), null);
  }
  for (const values of [[], ['90'], ['101', '-1'], ['bad'], ['100.001']]) {
    assert.equal(allocateBudget('100', categories(values)), null);
  }
});
