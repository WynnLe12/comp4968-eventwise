import "./testEnvironment";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createAppServer } from "../server";

async function withServer(
  callback: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createAppServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;

    await callback(
      `http://127.0.0.1:${address.port}`
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

const validBody = {
  totalBudget: "25000.00",
  categories: [
    {
      categoryId: "1",
      allocationPercentage: "60.00",
      plannedAmount: "15000.00",
    },
    {
      categoryId: "2",
      allocationPercentage: "40.00",
      plannedAmount: "10000.00",
    },
  ],
};

test("PATCH budget without token returns 401", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/events/1/budget`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validBody),
      }
    );

    assert.equal(response.status, 401);

    const result = await response.json() as {
      error?: string;
    };

    assert.ok(result.error);
  });
});

test("PATCH budget with empty Bearer token returns 401", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/events/1/budget`,
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validBody),
      }
    );

    assert.equal(response.status, 401);
  });
});

test("PATCH budget with invalid token returns 401", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/events/1/budget`,
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer invalid-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validBody),
      }
    );

    assert.equal(response.status, 401);
  });
});

test("Unknown budget path returns 404", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/events/1/unknown-budget-route`
    );

    assert.equal(response.status, 404);
  });
});

test("Existing health endpoint still works", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/health`
    );

    assert.equal(response.status, 200);

    const result = await response.json() as {
      status?: string;
    };

    assert.equal(result.status, "ok");
  });
});
