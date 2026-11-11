import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(relativePath, imports, replacements = {}) {
  let source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  const require = (id) => {
    assert.ok(id in imports, `Unexpected import: ${id}`);
    return imports[id];
  };
  new Function("require", "module", "exports", outputText)(require, module, module.exports);
  return module.exports;
}

function service(auth = {}, authConfigurationError = "") {
  return loadModule("../src/features/auth/services/authService.ts", {
    "aws-amplify/auth": auth,
    "../../../config/amplify": { authConfigurationError },
  });
}

const operations = ["signUp", "confirmSignUp", "resendSignUpCode", "signIn", "confirmSignIn", "signOut", "getCurrentUser", "fetchAuthSession", "resetPassword", "confirmResetPassword"];

test("service forwards Amplify inputs and preserves next-step results", async () => {
  for (const name of operations) {
    const input = { username: "planner@example.com", confirmationCode: "123456" };
    const output = { nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" } };
    let calls = 0;
    const api = service({ [name]: async (...args) => {
      calls++;
      assert.deepEqual(args, ["signOut", "getCurrentUser", "fetchAuthSession"].includes(name) ? [] : [input]);
      return output;
    } });
    assert.equal(await api[name](input), output);
    assert.equal(calls, 1);
  }
});

test("missing configuration blocks every auth operation before calling Amplify", async () => {
  const api = service({}, "Cognito configuration is missing.");
  for (const name of operations) await assert.rejects(api[name]({}), /configuration is missing/);
});

test("authenticated entry requires identity and a valid access token", async () => {
  const user = { userId: "test-user" };
  const session = { tokens: { accessToken: { payload: { exp: Date.now() / 1000 + 3600 } } } };
  const api = service({ getCurrentUser: async () => user, fetchAuthSession: async () => session });
  assert.deepEqual(await api.requireAuthSession(), { user, session });
});

test("identity alone, absent tokens, and expired access tokens cannot grant entry", async () => {
  for (const session of [{}, { tokens: {} }, { tokens: { accessToken: { payload: {} } } }, { tokens: { accessToken: { payload: { exp: 1 } } } }]) {
    const api = service({ getCurrentUser: async () => ({ userId: "test-user" }), fetchAuthSession: async () => session });
    await assert.rejects(api.requireAuthSession(), { name: "SessionExpiredError" });
  }
});

test("session and refresh failures are propagated without granting entry", async () => {
  const failure = new Error("Refresh failed");
  const api = service({ getCurrentUser: async () => ({ userId: "test-user" }), fetchAuthSession: async () => { throw failure; } });
  await assert.rejects(api.requireAuthSession(), (error) => error === failure);
  const signedOut = service({ getCurrentUser: async () => { throw failure; } });
  await assert.rejects(signedOut.requireAuthSession(), (error) => error === failure);
});

test("Cognito errors remain actionable without displaying raw error details", () => {
  const api = service();
  const error = new Error("Internal details that should not be displayed");
  error.name = "CodeMismatchException";
  assert.match(api.authErrorMessage(error), /code is incorrect/);
  error.name = "ExpiredCodeException";
  assert.match(api.authErrorMessage(error), /code has expired/);
  error.name = "NotAuthorizedException";
  assert.match(api.authErrorMessage(error), /email and password/);
  error.name = "UnknownException";
  assert.doesNotMatch(api.authErrorMessage(error), /Internal details/);
});

function configuration(env) {
  const calls = [];
  const exports = loadModule("../src/config/amplify.ts", {
    "aws-amplify": { Amplify: { configure: (value) => calls.push(value) } },
  }, { "import.meta.env": JSON.stringify(env) });
  return { ...exports, calls };
}

test("missing or inconsistent region configuration never initializes Amplify", () => {
  for (const env of [{}, { VITE_AWS_REGION: "us-east-1", VITE_COGNITO_USER_POOL_ID: "us-west-2_example", VITE_COGNITO_CLIENT_ID: "example" }]) {
    const result = configuration(env);
    assert.ok(result.authConfigurationError);
    assert.equal(result.calls.length, 0);
  }
});

test("valid configuration uses the pool region and public client ID", () => {
  const result = configuration({ VITE_AWS_REGION: "us-west-2", VITE_COGNITO_USER_POOL_ID: "us-west-2_example", VITE_COGNITO_CLIENT_ID: "example" });
  assert.equal(result.authConfigurationError, "");
  assert.deepEqual(result.calls, [{ Auth: { Cognito: { userPoolId: "us-west-2_example", userPoolClientId: "example" } } }]);
});
