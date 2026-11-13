import type { Pool, RowDataPacket } from "mysql2/promise";
import { db } from "../../shared/db/db";

export interface BudgetTotalCategoryUpdate {
    categoryId: string;
    allocationPercentage: string;
    plannedAmount: string;
}

export interface BudgetTotalUpdateInput {
    eventId: string;
    cognitoSub: string;
    totalBudget: string;
    categories: BudgetTotalCategoryUpdate[];
}

interface EventRow extends RowDataPacket {
    eventId: string;
    role: "OWNER" | "CO_PLANNER" | null;
}

interface CategoryRow extends RowDataPacket {
    categoryId: string;
}

export class BudgetTotalError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
    }
}

const MAX_BIGINT_ID = 18446744073709551615n;

function isValidId(value: string): boolean {
    return (
        typeof value === "string" &&
        /^[1-9][0-9]{0,19}$/.test(value) &&
        BigInt(value) <= MAX_BIGINT_ID
    );
}

function isValidMoney(value: string): boolean {
    return (
        typeof value === "string" &&
        /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)
    );
}

function isValidPercentage(value: string): boolean {
    return (
        typeof value === "string" &&
        /^(100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)$/.test(value)
    );
}

// Convert decimal strings into integer units without floating-point errors.
// For money: $25.50 -> 2550 cents.
// For percentages: 42.50% -> 4250 hundredths.
function toHundredths(value: string): bigint {
    const [whole, fraction = ""] = value.split(".");

    return (
        BigInt(whole) * 100n +
        BigInt(fraction.padEnd(2, "0"))
    );
}

export function validateBudgetTotalInput(
    input: BudgetTotalUpdateInput
): void {
    if (
        !isValidId(input.eventId) ||
        typeof input.cognitoSub !== "string" ||
        !input.cognitoSub.trim()
    ) {
        throw new BudgetTotalError(
            400,
            "Invalid event ID or authenticated user"
        );
    }

    if (!isValidMoney(input.totalBudget)) {
        throw new BudgetTotalError(
            400,
            "Total budget must be between 0 and 9999999999.99"
        );
    }

    if (
        !Array.isArray(input.categories) ||
        input.categories.length > 500
    ) {
        throw new BudgetTotalError(
            400,
            "Invalid budget categories"
        );
    }

    const totalCents = toHundredths(input.totalBudget);
    const categoryIds = new Set<string>();

    let totalPercentage = 0n;
    let totalAllocatedCents = 0n;

    for (const category of input.categories) {
        if (
            !category ||
            typeof category !== "object" ||
            !isValidId(category.categoryId)
        ) {
            throw new BudgetTotalError(
                400,
                "Invalid budget category ID"
            );
        }

        if (categoryIds.has(category.categoryId)) {
            throw new BudgetTotalError(
                400,
                "Duplicate budget category ID"
            );
        }

        categoryIds.add(category.categoryId);

        if (!isValidPercentage(category.allocationPercentage)) {
            throw new BudgetTotalError(
                400,
                `Invalid allocation percentage for category ${category.categoryId}`
            );
        }

        if (!isValidMoney(category.plannedAmount)) {
            throw new BudgetTotalError(
                400,
                `Invalid planned amount for category ${category.categoryId}`
            );
        }

        const percentageUnits = toHundredths(
            category.allocationPercentage
        );

        const actualCents = toHundredths(
            category.plannedAmount
        );

        // Round to the nearest cent.
        const expectedCents =
            (totalCents * percentageUnits + 5000n) / 10000n;

        const difference = actualCents - expectedCents;

        if (difference < -1n || difference > 1n) {
            throw new BudgetTotalError(
                400,
                `Category ${category.categoryId}: planned amount does not match its allocation percentage`
            );
        }

        totalPercentage += percentageUnits;
        totalAllocatedCents += actualCents;
    }

    if (totalPercentage > 10000n) {
        throw new BudgetTotalError(
            400,
            "Total category allocation cannot exceed 100%"
        );
    }

    if (totalAllocatedCents > totalCents) {
        throw new BudgetTotalError(
            400,
            "Total planned amounts cannot exceed the event budget"
        );
    }
}

export async function updateBudgetTotal(
    input: BudgetTotalUpdateInput,
    pool: Pick<Pool, "getConnection"> = db
): Promise<void> {
    // Reject invalid input before accessing MySQL.
    validateBudgetTotalInput(input);

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Lock the event and check the requesting user's membership.
        const [events] = await connection.execute<EventRow[]>(
            `SELECT
         CAST(e.event_id AS CHAR) AS eventId,
         m.role
       FROM events e
       LEFT JOIN event_members m
         ON m.event_id = e.event_id
         AND m.cognito_sub = ?
       WHERE e.event_id = ?
       FOR UPDATE`,
            [input.cognitoSub, input.eventId]
        );

        const event = events[0];

        if (!event) {
            throw new BudgetTotalError(404, "Event not found");
        }

        if (event.role !== "OWNER") {
            throw new BudgetTotalError(
                403,
                "Only the event owner can change the total budget"
            );
        }

        // Lock all existing categories for this event.
        const [existingCategories] =
            await connection.execute<CategoryRow[]>(
                `SELECT CAST(category_id AS CHAR) AS categoryId
         FROM budget_categories
         WHERE event_id = ?
         ORDER BY category_id
         FOR UPDATE`,
                [input.eventId]
            );

        const existingIds = new Set(
            existingCategories.map((category) => category.categoryId)
        );

        const suppliedIds = new Set(
            input.categories.map((category) => category.categoryId)
        );

        // Require the complete category list.
        if (
            existingIds.size !== suppliedIds.size ||
            input.categories.some(
                (category) => !existingIds.has(category.categoryId)
            )
        ) {
            throw new BudgetTotalError(
                409,
                "Budget categories changed. Reload the budget and try again."
            );
        }

        // Update total budget.
        await connection.execute(
            `UPDATE events
       SET total_budget = ?
       WHERE event_id = ?`,
            [input.totalBudget, input.eventId]
        );

        // Update category percentages and planned amounts.
        for (const category of input.categories) {
            await connection.execute(
                `UPDATE budget_categories
         SET allocation_percentage = ?,
             planned_amount = ?
         WHERE event_id = ? AND category_id = ?`,
                [
                    category.allocationPercentage,
                    category.plannedAmount,
                    input.eventId,
                    category.categoryId,
                ]
            );
        }

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}
