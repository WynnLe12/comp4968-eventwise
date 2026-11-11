
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { RowDataPacket } from "mysql2/promise";

import { getPool } from "../../shared/db/pool";
import { sendJson } from "../../shared/utils/http";

import {
  getEventBudget,
  listBudgetCategories,
  createBudgetCategory,
  updateBudgetCategory,
  deleteBudgetCategory,
  type BudgetCategoryInput,
} from "../repositories/budgetCategories";

interface EventMember extends RowDataPacket {
  role: "OWNER" | "CO_PLANNER";
}

interface DatabaseError {
  code?: string;
}

function isValidId(id: string): boolean {
  return (
    /^[1-9][0-9]{0,19}$/.test(id) &&
    BigInt(id) <= 18446744073709551615n
  );
}

// Validate MySQL DECIMAL(12,2) monetary values.
function isValidAmount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)
  );
}

// Validate percentages between 0 and 100.
function isValidPercentage(
  value: unknown
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      /^(?:100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)$/.test(value))
  );
}

function isValidCategory(
  value: unknown
): value is BudgetCategoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const input = value as Record<string, unknown>;

  return (
    typeof input.name === "string" &&
    input.name.trim().length > 0 &&
    input.name.trim().length <= 100 &&
    isValidAmount(input.plannedAmount) &&
    isValidPercentage(input.allocationPercentage) &&
    typeof input.sortOrder === "number" &&
    Number.isSafeInteger(input.sortOrder) &&
    input.sortOrder >= 0
  );
}

// Read a small JSON request body.
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    size += buffer.length;

    if (size > 16 * 1024) {
      throw new Error("Request body too large");
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function getEventMember(
  eventId: string,
  cognitoSub: string
): Promise<EventMember | null> {
  const [rows] = await getPool().execute<EventMember[]>(
    `SELECT role
     FROM event_members
     WHERE event_id = ? AND cognito_sub = ?
     LIMIT 1`,
    [eventId, cognitoSub]
  );

  return rows[0] ?? null;
}

// Compare decimal amounts using integer cents.
function toCents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, "0"));
}

// If a percentage is supplied, ensure its amount
// agrees with the event's total budget, within one cent.
function allocationMatchesBudget(
  input: BudgetCategoryInput,
  totalBudget: string
): boolean {
  if (input.allocationPercentage === null) {
    return true;
  }

  const totalCents = toCents(totalBudget);
  const percentageHundredths = toCents(
    input.allocationPercentage
  );

  const expectedCents =
    (totalCents * percentageHundredths + 5000n) / 10000n;

  const actualCents = toCents(input.plannedAmount);
  const difference = actualCents - expectedCents;

  return difference >= -1n && difference <= 1n;
}

// Process Budget Categories HTTP requests.
// cognitoSub must come from a VERIFIED Cognito identity.
export async function handleBudgetCategories(
  request: IncomingMessage,
  response: ServerResponse,
  cognitoSub: string | null
): Promise<boolean> {
  const path = request.url?.split("?")[0] ?? "/";

  const match =
    /^\/events\/([^/]+)\/budget-categories(?:\/([^/]+))?$/.exec(path);

  if (!match) return false;

  const eventId = match[1];
  const categoryId = match[2];
  const method = request.method;

  if (!isValidId(eventId) ||
      (categoryId !== undefined && !isValidId(categoryId))) {
    sendJson(response, 400, { error: "Invalid ID" });
    return true;
  }

  if (!cognitoSub) {
    sendJson(response, 401, {
      error: "Authentication required",
    });
    return true;
  }

  const member = await getEventMember(eventId, cognitoSub);

  if (!member) {
    sendJson(response, 403, {
      error: "Access denied",
    });
    return true;
  }

  const event = await getEventBudget(eventId);

  if (!event) {
    sendJson(response, 404, {
      error: "Event not found",
    });
    return true;
  }

  // GET: Retrieve the event's budget categories.
  if (method === "GET" && !categoryId) {
    const categories = await listBudgetCategories(eventId);

    sendJson(response, 200, {
      eventId: event.eventId,
      totalBudget: event.totalBudget,
      categories,
    });

    return true;
  }

  // The following operations change budget data.
  if (method === "POST" ||
      method === "PATCH" ||
      method === "DELETE") {
    if (member.role !== "OWNER" &&
        member.role !== "CO_PLANNER") {
      sendJson(response, 403, {
        error: "Insufficient permissions",
      });
      return true;
    }
  }

  // DELETE: Remove a category.
  if (method === "DELETE" && categoryId) {
    try {
      const deleted = await deleteBudgetCategory(
        eventId,
        categoryId
      );

      if (!deleted) {
        sendJson(response, 404, {
          error: "Budget category not found",
        });
      } else {
        sendJson(response, 200, {
          message: "Budget category deleted",
        });
      }
    } catch (error: unknown) {
      if ((error as DatabaseError).code === "ER_ROW_IS_REFERENCED_2") {
        sendJson(response, 409, {
          error: "Cannot delete a category that has expenses",
        });
      } else {
        throw error;
      }
    }

    return true;
  }

  // POST and PATCH require a JSON body.
  if (
    (method === "POST" && !categoryId) ||
    (method === "PATCH" && categoryId)
  ) {
    let body: unknown;

    try {
      body = await readJson(request);
    } catch (error: unknown) {
      const tooLarge =
        error instanceof Error &&
        error.message === "Request body too large";

      sendJson(response, tooLarge ? 413 : 400, {
        error: tooLarge
          ? "Request body too large"
          : "Invalid JSON body",
      });
      return true;
    }

    if (!isValidCategory(body)) {
      sendJson(response, 400, {
        error: "Invalid budget category data",
      });
      return true;
    }

    const input: BudgetCategoryInput = {
      name: body.name.trim(),
      allocationPercentage: body.allocationPercentage,
      plannedAmount: body.plannedAmount,
      sortOrder: body.sortOrder,
    };

    if (!allocationMatchesBudget(
      input,
      event.totalBudget
    )) {
      sendJson(response, 400, {
        error: "Allocation percentage and planned amount do not match the total budget",
      });
      return true;
    }

    try {
      if (method === "POST") {
        const newId = await createBudgetCategory(
          eventId,
          input
        );

        sendJson(response, 201, {
          categoryId: newId,
          message: "Budget category created",
        });
      } else {
        const updated = await updateBudgetCategory(
          eventId,
          categoryId!,
          input
        );

        if (!updated) {
          sendJson(response, 404, {
            error: "Budget category not found",
          });
        } else {
          sendJson(response, 200, {
            message: "Budget category updated",
          });
        }
      }
    } catch (error: unknown) {
      if ((error as DatabaseError).code === "ER_DUP_ENTRY") {
        sendJson(response, 409, {
          error: "Category name already exists for this event",
        });
      } else {
        throw error;
      }
    }

    return true;
  }

  sendJson(response, 405, {
    error: "Method not allowed",
  });
  return true;
}
