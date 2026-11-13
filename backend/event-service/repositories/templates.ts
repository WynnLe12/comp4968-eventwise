import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "../../shared/db/pool";

export interface Template extends RowDataPacket {
  templateId: string;
  templateKey: string;
  name: string;
  description: string | null;
}
export interface TemplateCategory extends RowDataPacket {
  templateCategoryId: string;
  name: string;
  defaultPercentage: string;
  sortOrder: number;
}
const columns = "CAST(template_id AS CHAR) AS templateId, template_key AS templateKey, name, description";

export async function listTemplates(): Promise<Template[]> {
  const [rows] = await getPool().execute<Template[]>(
    `SELECT ${columns} FROM event_templates ORDER BY template_id`,
  );
  return rows;
}

export async function getTemplate(templateId: string): Promise<(Template & { categories: TemplateCategory[] }) | null> {
  const [rows] = await getPool().execute<Template[]>(
    `SELECT ${columns} FROM event_templates WHERE template_id = ?`, [templateId],
  );
  if (!rows[0]) return null;
  const [categories] = await getPool().execute<TemplateCategory[]>(
    `SELECT CAST(template_category_id AS CHAR) AS templateCategoryId, name,
      default_percentage AS defaultPercentage, sort_order AS sortOrder
     FROM template_budget_categories WHERE template_id = ? ORDER BY sort_order, template_category_id`,
    [templateId],
  );
  return { ...rows[0], categories };
}
