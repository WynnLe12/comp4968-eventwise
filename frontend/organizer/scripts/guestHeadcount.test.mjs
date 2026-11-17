import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

const { partySize, totalHeadcount } = loadModule("../src/features/guests/guestHeadcount.ts");

test("a guest counts as one person, two with a plus-one", () => {
  assert.equal(partySize({ plusOneAllowed: false }), 1);
  assert.equal(partySize({ plusOneAllowed: true }), 2);
});

test("total guests includes plus-ones", () => {
  // The reported case: one guest without and one with a plus-one is 3 people, not 2.
  assert.equal(totalHeadcount([{ plusOneAllowed: false }, { plusOneAllowed: true }]), 3);
  assert.equal(totalHeadcount([{ plusOneAllowed: true }, { plusOneAllowed: true }]), 4);
});

test("an empty guest list has no guests", () => {
  assert.equal(totalHeadcount([]), 0);
});
