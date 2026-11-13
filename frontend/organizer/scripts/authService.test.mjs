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

const operations = ["signUp", "confirmSignUp", "resendSignUpCode", "signIn", "confirmSignIn", "signOut", "getCurrentUser", "fetchUserAttributes", "fetchAuthSession", "resetPassword", "confirmResetPassword"];

test("service forwards Amplify inputs and preserves next-step results", async () => {
  for (const name of operations) {
    const input = { username: "planner@example.com", confirmationCode: "123456" };
    const output = { nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" } };
    let calls = 0;
    const api = service({ [name]: async (...args) => {
      calls++;
      assert.deepEqual(args, ["signOut", "getCurrentUser", "fetchUserAttributes", "fetchAuthSession"].includes(name) ? [] : [input]);
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


test("profile uses given/family names first, then the full name attribute", () => {
  const api = service();
  assert.deepEqual(api.formatUserProfile({ given_name: "  Alex ", family_name: " Rivera ", name: "Other name", email: "alex@example.com" }, "username"), { displayName: "Alex Rivera", initials: "AR" });
  assert.deepEqual(api.formatUserProfile({ name: "  Alex Morgan Rivera  " }, "username"), { displayName: "Alex Morgan Rivera", initials: "AR" });
  assert.deepEqual(api.formatUserProfile({ given_name: "Alex" }, "username"), { displayName: "Alex", initials: "A" });
  assert.deepEqual(api.formatUserProfile({ given_name: "Alex", name: "Alex Rivera" }, "username"), { displayName: "Alex Rivera", initials: "AR" });
});

test("profile falls back to email or Cognito username and handles whitespace", () => {
  const api = service();
  assert.deepEqual(api.formatUserProfile({ given_name: " ", family_name: "", name: " ", email: "alex.rivera@example.com" }, "username"), { displayName: "alex.rivera@example.com", initials: "AR" });
  assert.deepEqual(api.formatUserProfile({}, "alex"), { displayName: "alex", initials: "A" });
  assert.deepEqual(api.formatUserProfile({}, ""), { displayName: "Account", initials: "A" });
});

test("profile loads attributes through Amplify for the current signed-in user", async () => {
  const api = service({
    getCurrentUser: async () => ({ username: "cognito-username", signInDetails: { loginId: "alex@example.com" } }),
    fetchUserAttributes: async () => ({ given_name: "Alex", family_name: "Rivera" }),
  });
  assert.deepEqual(await api.getUserProfile(), { displayName: "Alex Rivera", initials: "AR" });
  const fallback = service({ getCurrentUser: async () => ({ username: "cognito-username" }), fetchUserAttributes: async () => ({}) });
  assert.deepEqual(await fallback.getUserProfile(), { displayName: "cognito-username", initials: "CU" });
});

test("profile failures propagate to the UI's neutral fallback", async () => {
  const failure = new Error("Unable to fetch attributes");
  const api = service({ getCurrentUser: async () => ({ username: "alex" }), fetchUserAttributes: async () => { throw failure; } });
  await assert.rejects(api.getUserProfile(), (error) => error === failure);
  const signedOut = service({ getCurrentUser: async () => { throw failure; } });
  await assert.rejects(signedOut.getUserProfile(), (error) => error === failure);
});


test("profile lifecycle clears on logout/switching and ignores stale or unmounted requests", async () => {
  const previousWindow = globalThis.window;
  const values = [];
  const requests = [];
  let effect;
  let onAuth;
  let onFocus;
  let unsubscribed = false;
  globalThis.window = {
    addEventListener: (event, callback) => { assert.equal(event, "focus"); onFocus = callback; },
    removeEventListener: (event, callback) => { assert.equal(event, "focus"); assert.equal(callback, onFocus); },
  };
  try {
    const api = loadModule("../src/features/auth/hooks/useUserProfile.ts", {
      react: {
        useState: (initial) => {
          const index = values.length;
          values.push(initial);
          return [initial, (next) => { values[index] = next; }];
        },
        useEffect: (callback) => { effect = callback; },
      },
      "aws-amplify/utils": { Hub: { listen: (channel, callback) => {
        assert.equal(channel, "auth"); onAuth = callback;
        return () => { unsubscribed = true; };
      } } },
      "../services/authService": { getUserProfile: () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); }) },
    });
    api.useUserProfile();
    const cleanup = effect();
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(values, [null, true]);
    onAuth({ payload: { event: "signedOut" } });
    requests[0].resolve({ displayName: "Old user", initials: "OU" });
    await settle();
    assert.deepEqual(values, [null, false]);

    onAuth({ payload: { event: "signedIn" } });
    const current = { displayName: "Current user", initials: "CU" };
    requests[1].resolve(current);
    await settle();
    assert.deepEqual(values, [current, false]);

    onAuth({ payload: { event: "signedIn" } });
    assert.deepEqual(values, [null, true]);
    requests[2].reject(new Error("Authentication failed"));
    await settle();
    assert.deepEqual(values, [null, false]);

    onFocus();
    requests[3].resolve(current);
    await settle();
    onAuth({ payload: { event: "tokenRefresh_failure" } });
    assert.deepEqual(values, [null, false]);

    onAuth({ payload: { event: "signedIn" } });
    cleanup();
    requests[4].resolve({ displayName: "Late user", initials: "LU" });
    await settle();
    assert.equal(values[0], null);
    assert.ok(unsubscribed);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
