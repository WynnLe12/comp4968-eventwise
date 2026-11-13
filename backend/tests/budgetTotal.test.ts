import assert from "node:assert/strict";
import { test } from "node:test";

import {
    BudgetTotalError,
    validateBudgetTotalInput,
    type BudgetTotalUpdateInput,
} from "../event-service/repositories/budgetTotal";

// Create valid test data.
function validInput(): BudgetTotalUpdateInput {
    return {
        eventId: "1",
        cognitoSub: "test-cognito-user",
        totalBudget: "20000.00",
        categories: [
            {
                categoryId: "1",
                allocationPercentage: "60.00",
                plannedAmount: "12000.00",
            },
            {
                categoryId: "2",
                allocationPercentage: "40.00",
                plannedAmount: "8000.00",
            },
        ],
    };
}

// Helper: check whether a validation error has the expected status.
function expectValidationError(
    input: BudgetTotalUpdateInput,
    expectedStatus: number
): void {
    assert.throws(
        () => validateBudgetTotalInput(input),
        (error: unknown) =>
            error instanceof BudgetTotalError &&
            error.status === expectedStatus
    );
}

test("Accept valid total budget and category allocations", () => {
    assert.doesNotThrow(() =>
        validateBudgetTotalInput(validInput())
    );
});

test("Reject invalid event ID", () => {
    const input = validInput();
    input.eventId = "abc";

    expectValidationError(input, 400);
});

test("Reject missing authenticated user", () => {
    const input = validInput();
    input.cognitoSub = "";

    expectValidationError(input, 400);
});

test("Reject negative total budget", () => {
    const input = validInput();
    input.totalBudget = "-100.00";

    expectValidationError(input, 400);
});

test("Reject total budget exceeding MySQL decimal limit", () => {
    const input = validInput();
    input.totalBudget = "10000000000.00";

    expectValidationError(input, 400);
});

test("Reject category percentage greater than 100", () => {
    const input = validInput();
    input.categories[0].allocationPercentage = "101.00";

    expectValidationError(input, 400);
});

test("Reject combined percentages exceeding 100", () => {
    const input = validInput();

    input.categories = [
        {
            categoryId: "1",
            allocationPercentage: "70.00",
            plannedAmount: "14000.00",
        },
        {
            categoryId: "2",
            allocationPercentage: "40.00",
            plannedAmount: "8000.00",
        },
    ];

    expectValidationError(input, 400);
});

test("Reject duplicate category IDs", () => {
    const input = validInput();
    input.categories[1].categoryId = "1";

    expectValidationError(input, 400);
});

test("Reject planned amount that does not match allocation", () => {
    const input = validInput();
    input.categories[0].plannedAmount = "15000.00";

    expectValidationError(input, 400);
});

test("Allow a one-cent allocation rounding difference", () => {
    const input = validInput();

    // Keep the individual difference within one cent
    // without exceeding the total event budget.
    input.categories[0].plannedAmount = "11999.99";

    assert.doesNotThrow(() =>
        validateBudgetTotalInput(input)
    );
});

test("Reject a two-cent allocation difference", () => {
    const input = validInput();
    input.categories[0].plannedAmount = "12000.02";

    expectValidationError(input, 400);
});

test("Reject category amounts exceeding the event budget", () => {
    const input = validInput();

    input.totalBudget = "0.01";
    input.categories = [
        {
            categoryId: "1",
            allocationPercentage: "50.00",
            plannedAmount: "0.01",
        },
        {
            categoryId: "2",
            allocationPercentage: "50.00",
            plannedAmount: "0.01",
        },
    ];

    expectValidationError(input, 400);
});

test("Accept an event with no budget categories", () => {
    const input = validInput();
    input.categories = [];

    assert.doesNotThrow(() =>
        validateBudgetTotalInput(input)
    );
});
