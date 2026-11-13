export interface EventTemplate {
  templateId: string;
  templateKey: string;
  name: string;
  description: string | null;
}

export interface TemplateCategory {
  templateCategoryId: string;
  name: string;
  defaultPercentage: string;
  sortOrder: number;
}

export interface EventTemplateDetails extends EventTemplate {
  categories: TemplateCategory[];
}

export interface TemplatesResponse { templates: EventTemplate[] }
export interface TemplateResponse { template: EventTemplateDetails }
