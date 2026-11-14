// Public API location only; never put credentials in Vite environment variables.
const base = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
export function apiUrl(path: string): string { return `${base}${path}`; }
