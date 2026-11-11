
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "../../shared/db/pool";

// Represents one budget category stored in MySQL.
export interface BudgetCategory extends RowDataPacket {
  categoryId: string;
  eventId: string;
  name: string;
  allocationPercentage: string | null;
  plannedAmount: string;
  sortOrder: number;
}

// Represents an event's total budget.
export interface EventBudget extends RowDataPacket {
  eventId: string;
  totalBudget: string;
}

// Retrieve all budget categories for a specific event.
export async function listBudgetCategories(
  eventId: string
): Promise<BudgetCategory[]> {
  const [rows] = await getPool().execute<BudgetCategory[]>(
    `SELECT
       CAST(category_id AS CHAR) AS categoryId,
       CAST(event_id AS CHAR) AS eventId,
       name,
       allocation_percentage AS allocationPercentage,
       planned_amount AS plannedAmount,
       sort_order AS sortOrder
     FROM budget_categories
     WHERE event_id = ?
     ORDER BY sort_order, category_id`,
    [eventId]
  );

  return rows;
}

// Retrieve the total budget for a specific event.
export async function getEventBudget(
  eventId: string
): Promise<EventBudget | null> {
  const [rows] = await getPool().execute<EventBudget[]>(
    `SELECT
       CAST(event_id AS CHAR) AS eventId,
       total_budget AS totalBudget
     FROM events
     WHERE event_id = ?`,
    [eventId]
  );

  return rows[0] ?? null;
}

export interface BudgetCategoryInput {
  name: string;
  allocationPercentage: string | null;
  plannedAmount: string;
  sortOrder: number;
}

// Create a new category for an event.
export async function createBudgetCategory(
  eventId: string,
  input: BudgetCategoryInput
): Promise<string> {
  const [result] = await getPool().execute<ResultSetHeader>(
    `INSERT INTO budget_categories
       (event_id, name, allocation_percentage, planned_amount, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [
      eventId,
      input.name,
      input.allocationPercentage,
      input.plannedAmount,
      input.sortOrder
    ]
  );

  return String(result.insertId);
}

// Update an existing category.
export async function updateBudgetCategory(
  eventId: string,
  categoryId: string,
  input: BudgetCategoryInput
): Promise<boolean> {
  const [result] = await getPool().execute<ResultSetHeader>(
    `UPDATE budget_categories
     SET name = ?,
         allocation_percentage = ?,
         planned_amount = ?,
         sort_order = ?
     WHERE event_id = ? AND category_id = ?`,
    [
      input.name,
      input.allocationPercentage,
      input.plannedAmount,
      input.sortOrder,
      eventId,
      categoryId
    ]
  );

  return result.affectedRows > 0;
}

// Delete a category belonging to an event.
export async function deleteBudgetCategory(
  eventId: string,
  categoryId: string
): Promise<boolean> {
  const [result] = await getPool().execute<ResultSetHeader>(
    `DELETE FROM budget_categories
     WHERE event_id = ? AND category_id = ?`,
    [eventId, categoryId]
  );

  return result.affectedRows > 0;
}
