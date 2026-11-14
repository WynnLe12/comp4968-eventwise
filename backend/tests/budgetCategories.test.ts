
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { handleBudgetCategories } from
  "../event-service/handlers/budgetCategories";
import { sendJson } from "../shared/utils/http";

// Test server with no authenticated Cognito user.
const server = createServer((request, response) => {
  void handleBudgetCategories(
    request,
    response,
    null
  )
    .then((handled) => {
      if (!handled) {
        sendJson(response, 404, {
          error: "Not found",
        });
      }
    })
    .catch((error: unknown) => {
      console.error(error);
      sendJson(response, 500, {
        error: "Internal server error",
      });
    });
});

let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

// Test 1: Invalid event ID.
test("Reject invalid event ID", async () => {
  const response = await fetch(
    `${baseUrl}/events/abc/budget-categories`
  );

  assert.equal(response.status, 400);
});

// Test 2: Authentication required for GET.
test("GET requires authentication", async () => {
  const response = await fetch(
    `${baseUrl}/events/1/budget-categories`
  );

  assert.equal(response.status, 401);
});

// Test 3: Authentication required for POST.
test("POST requires authentication", async () => {
  const response = await fetch(
    `${baseUrl}/events/1/budget-categories`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Catering",
        allocationPercentage: "30.00",
        plannedAmount: "6000.00",
        sortOrder: 1,
      }),
    }
  );

  assert.equal(response.status, 401);
});

// Test 4: Authentication required for PATCH.
test("PATCH requires authentication", async () => {
  const response = await fetch(
    `${baseUrl}/events/1/budget-categories/1`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Catering",
        allocationPercentage: "35.00",
        plannedAmount: "7000.00",
        sortOrder: 1,
      }),
    }
  );

  assert.equal(response.status, 401);
});

// Test 5: Authentication required for DELETE.
test("DELETE requires authentication", async () => {
  const response = await fetch(
    `${baseUrl}/events/1/budget-categories/1`,
    {
      method: "DELETE",
    }
  );

  assert.equal(response.status, 401);
});

// Test 6: Reject an invalid category ID.
test("Reject invalid category ID", async () => {
  const response = await fetch(
    `${baseUrl}/events/1/budget-categories/abc`,
    {
      method: "DELETE",
    }
  );

  assert.equal(response.status, 400);
});

// Test 7: Reject unrelated routes.
test("Ignore unrelated routes", async () => {
  const response = await fetch(
    `${baseUrl}/event-templates`
  );

  assert.equal(response.status, 404);
});
