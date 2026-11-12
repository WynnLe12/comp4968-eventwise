export interface AllocationInput { templateCategoryId: string; defaultPercentage: string }

/** Provisional rule: integer cents, largest remainder, template order breaks ties. */
export function allocateBudget(total: string, categories: AllocationInput[]): number[] | null {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(total)) return null;
  const [whole, fraction = ""] = total.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const percentages = categories.map(category => {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(category.defaultPercentage)) return -1;
    return Math.round(Number(category.defaultPercentage) * 100);
  });
  if (!categories.length || percentages.some(value => value < 0 || value > 10000)
    || percentages.reduce((sum, value) => sum + value, 0) !== 10000) return null;
  const products = percentages.map(value => cents * BigInt(value));
  const amounts = products.map(value => Number(value / 10000n));
  const remaining = Number(cents) - amounts.reduce((sum, value) => sum + value, 0);
  const order = products.map((value, index) => ({ index, remainder: value % 10000n }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < remaining; index++) amounts[order[index].index]++;
  return amounts;
}
