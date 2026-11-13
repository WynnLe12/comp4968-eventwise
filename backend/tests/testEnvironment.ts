// Public, non-secret fixtures: tests mock successful JWT verification and database work.
process.env.COGNITO_USER_POOL_ID ??= "us-west-2_testpool";
process.env.COGNITO_CLIENT_ID ??= "testclient";
