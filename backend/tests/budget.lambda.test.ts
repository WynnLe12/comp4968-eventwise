import test from "node:test";
import assert from "node:assert/strict";

import { handler, createBudgetHandler, } from "../event-service/lambda/budget";

test("Budget Lambda returns 404 for unknown routes", async () => {
    const result = await handler({
        httpMethod: "GET",
        path: "/unknown",
    });

    assert.equal(result.statusCode, 404);
    assert.deepEqual(JSON.parse(result.body), {
        error: "Not found",
    });
});

test("Budget Lambda handles CORS preflight", async () => {
    const result = await handler({
        httpMethod: "OPTIONS",
        path: "/events/1/budget-categories",
    });

    assert.equal(result.statusCode, 204);
    assert.equal(result.body, "");
    assert.match(
        result.headers["Access-Control-Allow-Methods"],
        /PATCH/
    );
});

test("Budget Categories requires authentication", async () => {
    const result = await handler({
        httpMethod: "GET",
        path: "/events/1/budget-categories",
    });

    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), {
        error: "Missing authentication token",
    });
});

test("Total Budget requires authentication", async () => {
    const result = await handler({
        httpMethod: "PATCH",
        path: "/events/1/budget",
        body: JSON.stringify({
            totalBudget: "20000.00",
            categories: [],
        }),
    });

    assert.equal(result.statusCode, 401);
});

test("Budget Lambda rejects malformed Bearer headers", async () => {
    const result = await handler({
        httpMethod: "GET",
        path: "/events/1/budget-categories",
        headers: {
            Authorization: "NotBearer abc123",
        },
    });

    assert.equal(result.statusCode, 401);
});

test("Budget Lambda rejects oversized request bodies", async () => {
    const result = await handler({
        httpMethod: "POST",
        path: "/events/1/budget-categories",
        headers: {
            Authorization: "Bearer test-token",
        },
        body: "x".repeat(20 * 1024),
    });

    // Authentication must fail before the request reaches MySQL.
    assert.equal(result.statusCode, 401);
});

test("Authenticated request reaches Budget Categories handler", async () => {
    let receivedToken = "";

    const mockAuthenticate = async (token: string): Promise<string> => {
        receivedToken = token;
        return "test-cognito-user-123";
    };

    const authenticatedHandler = createBudgetHandler(mockAuthenticate);

    const result = await authenticatedHandler({
        httpMethod: "GET",
        path: "/events/abc/budget-categories",
        headers: {
            Authorization: "Bearer valid-test-token",
        },
    });

    // Verify that our mock Cognito function received the token.
    assert.equal(receivedToken, "valid-test-token");

    // The existing Budget Categories handler validates event IDs.
    // "abc" is invalid, so it should return 400 before using MySQL.
    assert.equal(result.statusCode, 400);

    assert.deepEqual(JSON.parse(result.body), {
        error: "Invalid ID",
    });
});

test("Authenticated Total Budget request validates JSON body", async () => {
    let receivedToken = "";

    const mockAuthenticate = async (token: string): Promise<string> => {
        receivedToken = token;
        return "test-cognito-user-123";
    };

    const authenticatedHandler = createBudgetHandler(mockAuthenticate);

    const result = await authenticatedHandler({
        httpMethod: "PATCH",
        path: "/events/1/budget",
        headers: {
            Authorization: "Bearer valid-test-token",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            totalBudget: "20000.00",
            // Missing required categories array.
        }),
    });

    assert.equal(receivedToken, "valid-test-token");

    // The original Total Budget handler should reject the
    // incomplete JSON body before updating MySQL.
    assert.equal(result.statusCode, 400);

    assert.deepEqual(JSON.parse(result.body), {
        error: "Invalid total budget request data",
    });
});
