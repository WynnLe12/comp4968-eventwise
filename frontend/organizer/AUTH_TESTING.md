# Cognito frontend testing

## Setup

1. Copy `.env.example` to `.env.local` and set `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`, and `VITE_AWS_REGION` for your pool. Restart Vite after changes.
2. Use a Cognito public app client **without a client secret**, with password/SRP sign-in enabled. The pool must support email sign-in, email verification by code, password recovery by email, and the `email`, `given_name`, and `family_name` attributes. Its password policy still applies.
3. Run `npm run dev` from this directory. Use a test email inbox you control. No AWS access keys belong in this frontend.

## Registration and email verification

- From the landing page choose **Plan your event**. Enter first name, last name, email, and a policy-compliant password; submit using the button or Enter.
- Confirm blank/invalid fields cannot submit, and controls disable during a request.
- Expect the existing auth card to request an email verification code; it must not open the dashboard.
- Try an incorrect code, then **Resend verification code**. Use the latest emailed code and verify. Choose **Sign in** after confirmation.
- Also try logging in with a registered, unconfirmed email. Expect verification and resend controls, without dashboard access.
- Register an existing email and check the error message. The optional event-type field is UI-only; it is not stored in Cognito.

## Login and session protection

- Enter the verified email/password. The dashboard opens only after Cognito finishes all required steps and a valid session is available.
- Try an incorrect password; expect a friendly error and no dashboard access.
- Refresh `/app/dashboard` while signed in. The session should be restored without flashing protected content before the check finishes.
- In an incognito window, visit `/app/dashboard` or `/app/events` directly. Expect login. The landing **Explore the demo** button also requires a real session and cannot create demo credentials or bypass the guard.
- If the test pool enables SMS/email/TOTP MFA, complete the returned challenge. With TOTP setup, add the displayed setup key to an authenticator app and enter its generated code. Test MFA selection/setup, temporary-password changes (including any missing attributes), and custom challenges if configured in your pool. Invalid answers must keep the dashboard locked.
- If an unsupported step is returned, access remains blocked. A pending sign-in must be restarted after reloading the page.
- Clear the session or let it expire without a usable refresh token; refocus the window or wait for the periodic session check. Expect login. Refreshable sessions should remain signed in.

## Logout

- Use the existing topbar logout action. Expect a signing-out state, followed by the landing page only after Cognito sign-out completes.
- Refresh, use Back, or open a protected URL directly. Expect login, not the previous workspace.
- If sign-out fails, expect an error message rather than a successful sign-out indication; retry the action.

## Password reset

- While signed out, select **Forgot password?**, enter the registered email, and choose **Send reset code**.
- Enter an incorrect code or a password rejected by the pool and check the error message.
- Request a replacement code with **Resend verification code**. Enter the latest emailed code and a new password; submit.
- Expect the login screen. Confirm the old password fails and the new password works, including any MFA challenge.

## Local checks

```sh
npm run typecheck
npm run build
git diff --check
node --test scripts/authService.test.mjs
```

The local service tests mock Amplify; live registration, delivery, pool policies, and MFA must be verified against your test Cognito pool. Frontend route guards do not replace future backend authorization. This change does not add authenticated event APIs.
