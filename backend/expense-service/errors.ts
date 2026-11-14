export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}
export function invalid(field: string, message: string): never {
  throw new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", { [field]: message });
}
