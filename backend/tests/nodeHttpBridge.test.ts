import test from "node:test";
import assert from "node:assert/strict";

import { invokeNodeHttpHandler } from "../shared/lambda/nodeHttpBridge";
import { sendJson } from "../shared/utils/http";

test("HTTP bridge returns the correct JSON response", async () => {
    const result = await invokeNodeHttpHandler(
        "GET",
        "/events/1/budget-categories",
        Buffer.alloc(0),
        async (request, response) => {
            assert.equal(request.method, "GET");
            assert.equal(request.url, "/events/1/budget-categories");

            sendJson(response, 200, {
                eventId: "1",
                totalBudget: "1000.00",
                categories: [],
            });
        }
    );

    assert.equal(result.statusCode, 200);
    assert.match(result.headers["Content-Type"], /application\/json/);

    assert.deepEqual(JSON.parse(result.body), {
        eventId: "1",
        totalBudget: "1000.00",
        categories: [],
    });
});

test("HTTP bridge forwards a JSON request body", async () => {
    const input = {
        totalBudget: "20000.00",
        categories: [],
    };

    const body = Buffer.from(JSON.stringify(input));

    const result = await invokeNodeHttpHandler(
        "PATCH",
        "/events/1/budget",
        body,
        async (request, response) => {
            const chunks: Buffer[] = [];

            for await (const chunk of request) {
                chunks.push(
                    Buffer.isBuffer(chunk)
                        ? chunk
                        : Buffer.from(chunk)
                );
            }

            const received = JSON.parse(
                Buffer.concat(chunks).toString("utf8")
            );

            assert.equal(request.method, "PATCH");
            assert.equal(request.url, "/events/1/budget");
            assert.deepEqual(received, input);

            sendJson(response, 200, {
                message: "Request body received",
            });
        }
    );

    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
        message: "Request body received",
    });
});

test("HTTP bridge preserves response links, allowed methods and private cache headers", async () => {
    const result = await invokeNodeHttpHandler(
        "POST", "/events/12/contract-drafts/23/confirm", Buffer.from('{"version":"1"}'),
        async (_request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Allow", "POST, OPTIONS");
            response.setHeader("Location", "/events/12/expenses/9007199254740993");
            sendJson(response, 201, { data: { confirmedExpenseId: "9007199254740993" } });
        },
        { "Content-Type": "application/json" },
    );
    assert.equal(result.statusCode, 201);
    assert.equal(result.headers.Location, "/events/12/expenses/9007199254740993");
    assert.equal(result.headers.Allow, "POST, OPTIONS");
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.match(result.headers["Content-Type"], /application\/json/);
    assert.deepEqual(JSON.parse(result.body), { data: { confirmedExpenseId: "9007199254740993" } });
});
