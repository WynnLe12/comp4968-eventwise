import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "mysql2/promise";

import {
    updateBudgetTotal,
    BudgetTotalError,
    type BudgetTotalUpdateInput,
} from "../event-service/repositories/budgetTotal";

function validInput(): BudgetTotalUpdateInput {
    return {
        eventId: "1",
        cognitoSub: "test-owner",
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
}

type MockOptions = {
    role?: "OWNER" | "CO_PLANNER" | null;
    eventExists?: boolean;
    categoryIds?: string[];
    failOnUpdate?: boolean;
    failOnCommit?: boolean;
};

function createMockDatabase(options: MockOptions = {}) {
    const calls: string[] = [];

    const connection = {
        async beginTransaction() {
            calls.push("begin");
        },

        async execute(sql: string) {
            if (sql.includes("FROM events e")) {
                calls.push("select-event");

                return [
                    options.eventExists === false
                        ? []
                        : [{
                            eventId: "1",
                            role: options.role === undefined
                                ? "OWNER"
                                : options.role,
                        }],
                    [],
                ];
            }

            if (sql.includes("FROM budget_categories")) {
                calls.push("select-categories");

                return [
                    (options.categoryIds ?? ["1", "2"]).map(
                        (categoryId) => ({ categoryId })
                    ),
                    [],
                ];
            }

            if (sql.includes("UPDATE events")) {
                calls.push("update-event");

                if (options.failOnUpdate) {
                    throw new Error("Simulated database failure");
                }

                return [{ affectedRows: 1 }, []];
            }

            if (sql.includes("UPDATE budget_categories")) {
                calls.push("update-category");

                return [{ affectedRows: 1 }, []];
            }

            throw new Error(`Unexpected SQL: ${sql}`);
        },

        async commit() {
            calls.push("commit");

            if (options.failOnCommit) {
                throw new Error("Simulated commit failure");
            }
        },

        async rollback() {
            calls.push("rollback");
        },

        release() {
            calls.push("release");
        },
    };

    // The mock supplies only the MySQL methods used by this repository.
    const pool = {
        async getConnection() {
            calls.push("get-connection");
            return connection;
        },
    } as unknown as Pick<Pool, "getConnection">;

    return { pool, calls };
}

test("OWNER can update total budget and categories in one transaction", async () => {
    const { pool, calls } = createMockDatabase();

    await updateBudgetTotal(validInput(), pool);

    assert.deepEqual(calls, [
        "get-connection",
        "begin",
        "select-event",
        "select-categories",
        "update-event",
        "update-category",
        "update-category",
        "commit",
        "release",
    ]);
});

test("CO_PLANNER cannot update total budget", async () => {
    const { pool, calls } = createMockDatabase({
        role: "CO_PLANNER",
    });

    await assert.rejects(
        updateBudgetTotal(validInput(), pool),
        (error: unknown) =>
            error instanceof BudgetTotalError &&
            error.status === 403
    );

    assert.ok(calls.includes("rollback"));
    assert.ok(calls.includes("release"));
    assert.ok(!calls.includes("update-event"));
    assert.ok(!calls.includes("commit"));
});

test("Missing event returns 404", async () => {
    const { pool, calls } = createMockDatabase({
        eventExists: false,
    });

    await assert.rejects(
        updateBudgetTotal(validInput(), pool),
        (error: unknown) =>
            error instanceof BudgetTotalError &&
            error.status === 404
    );

    assert.ok(calls.includes("rollback"));
    assert.ok(!calls.includes("commit"));
});

test("Reject category IDs that do not belong to the event", async () => {
    const { pool, calls } = createMockDatabase({
        categoryIds: ["1", "3"],
    });

    await assert.rejects(
        updateBudgetTotal(validInput(), pool),
        (error: unknown) =>
            error instanceof BudgetTotalError &&
            error.status === 409
    );

    assert.ok(calls.includes("rollback"));
    assert.ok(!calls.includes("update-event"));
});

test("Database update failure rolls back the transaction", async () => {
    const { pool, calls } = createMockDatabase({
        failOnUpdate: true,
    });

    await assert.rejects(
        updateBudgetTotal(validInput(), pool),
        /Simulated database failure/
    );

    assert.ok(calls.includes("rollback"));
    assert.ok(calls.includes("release"));
    assert.ok(!calls.includes("commit"));
});

test("Commit failure attempts rollback and releases connection", async () => {
    const { pool, calls } = createMockDatabase({
        failOnCommit: true,
    });

    await assert.rejects(
        updateBudgetTotal(validInput(), pool),
        /Simulated commit failure/
    );

    assert.ok(calls.includes("commit"));
    assert.ok(calls.includes("rollback"));
    assert.ok(calls.includes("release"));
});

test("Invalid input is rejected before acquiring a connection", async () => {
    const { pool, calls } = createMockDatabase();

    const input = validInput();
    input.totalBudget = "-100.00";

    await assert.rejects(
        updateBudgetTotal(input, pool),
        (error: unknown) =>
            error instanceof BudgetTotalError &&
            error.status === 400
    );

    assert.deepEqual(calls, []);
});
