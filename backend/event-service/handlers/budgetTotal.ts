import type {
    IncomingMessage,
    ServerResponse,
} from "node:http";

import {
    BudgetTotalError,
    updateBudgetTotal,
    type BudgetTotalCategoryUpdate,
    type BudgetTotalUpdateInput,
} from "../repositories/budgetTotal";

import { sendJson } from "../../shared/utils/http";

const MAX_BODY_SIZE = 64 * 1024;

interface BudgetTotalRequestBody {
    totalBudget: string;
    categories: BudgetTotalCategoryUpdate[];
}

// Read JSON safely, limiting the maximum request size.
async function readJsonBody(
    request: IncomingMessage
): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

        size += buffer.length;

        if (size > MAX_BODY_SIZE) {
            throw new BudgetTotalError(
                413,
                "Request body is too large"
            );
        }

        chunks.push(buffer);
    }

    try {
        return JSON.parse(
            Buffer.concat(chunks).toString("utf8")
        ) as unknown;
    } catch {
        throw new BudgetTotalError(
            400,
            "Invalid JSON request body"
        );
    }
}

// Check the request structure before passing it to the repository.
// Detailed decimal and allocation validation happens in budgetTotal.ts.
function isBudgetTotalBody(
    body: unknown
): body is BudgetTotalRequestBody {
    if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
    ) {
        return false;
    }

    const data = body as Record<string, unknown>;

    if (
        typeof data.totalBudget !== "string" ||
        !Array.isArray(data.categories) ||
        data.categories.length > 500
    ) {
        return false;
    }

    return data.categories.every((category: unknown) => {
        if (
            !category ||
            typeof category !== "object" ||
            Array.isArray(category)
        ) {
            return false;
        }

        const item = category as Record<string, unknown>;

        return (
            typeof item.categoryId === "string" &&
            typeof item.allocationPercentage === "string" &&
            typeof item.plannedAmount === "string"
        );
    });
}

// Handle PATCH /events/:eventId/budget.
//
// IMPORTANT:
// cognitoSub must come from a verified Cognito access token,
// never from the client request body.
export async function handleBudgetTotal(
    request: IncomingMessage,
    response: ServerResponse,
    cognitoSub: string | null
): Promise<boolean> {
    const path = request.url?.split("?")[0] ?? "/";

    const match = /^\/events\/([^/]+)\/budget$/.exec(path);

    if (!match) {
        return false;
    }

    if (request.method !== "PATCH") {
        sendJson(response, 405, {
            error: "Method not allowed",
        });
        return true;
    }

    if (!cognitoSub) {
        sendJson(response, 401, {
            error: "Authentication required",
        });
        return true;
    }

    try {
        const body = await readJsonBody(request);

        if (!isBudgetTotalBody(body)) {
            sendJson(response, 400, {
                error: "Invalid total budget request data",
            });
            return true;
        }

        const input: BudgetTotalUpdateInput = {
            eventId: match[1],
            cognitoSub,
            totalBudget: body.totalBudget,
            categories: body.categories,
        };

        // Validates the data and updates MySQL atomically.
        await updateBudgetTotal(input);

        sendJson(response, 200, {
            message: "Total budget and categories updated successfully",
        });

        return true;
    } catch (error: unknown) {
        if (error instanceof BudgetTotalError) {
            sendJson(response, error.status, {
                error: error.message,
            });

            return true;
        }

        // Never expose database errors to the client.
        console.error("Total Budget update failed", error);

        sendJson(response, 500, {
            error: "Internal server error",
        });

        return true;
    }
}
