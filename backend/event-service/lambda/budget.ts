import { verifyToken } from "../../shared/auth/verifyToken";
import { invokeNodeHttpHandler } from "../../shared/lambda/nodeHttpBridge";
import { handleBudgetCategories } from "../handlers/budgetCategories";
import { handleBudgetTotal } from "../handlers/budgetTotal";

interface BudgetProxyEvent {
    httpMethod: string;
    path: string;
    headers?: Record<string, string | undefined> | null;
    body?: string | null;
    isBase64Encoded?: boolean;
}

interface BudgetProxyResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    isBase64Encoded: false;
}

const corsHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function respond(statusCode: number, body: object): BudgetProxyResponse {
    return {
        statusCode,
        headers: corsHeaders,
        body: JSON.stringify(body),
        isBase64Encoded: false,
    };
}

function getBearerToken(headers?: Record<string, string | undefined> | null): string | null {
    const authorization = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];

    const match = /^Bearer ([^\s]+)$/i.exec(authorization?.trim() ?? "");

    return match?.[1] ?? null;
}

export function createBudgetHandler(authenticate: (token: string) => Promise<string> = verifyToken) {
    return async function handler(
        event: BudgetProxyEvent
    ): Promise<BudgetProxyResponse> {
        const method = event.httpMethod;
        const path = event.path;

        // Handle only Budget Categories and Total Budget routes.
        const categoryRoute = /^\/events\/[^/]+\/budget-categories(?:\/[^/]+)?$/.test(path);
        const totalRoute = /^\/events\/[^/]+\/budget$/.test(path);

        if (!categoryRoute && !totalRoute) {
            return respond(404, { error: "Not found" });
        }

        // Browser CORS preflight does not require authentication.
        if (method === "OPTIONS") {
            return {
                ...respond(204, {}),
                body: "",
            };
        }

        const token = getBearerToken(event.headers);

        if (!token) {
            return respond(401, {
                error: "Missing authentication token",
            });
        }

        let cognitoSub: string;

        try {
            // Never trust user identity from the request body.
            cognitoSub = await authenticate(token);
        } catch {
            return respond(401, {
                error: "Invalid or expired authentication token",
            });
        }

        let body: Buffer;

        try {
            body = event.body
                ? Buffer.from(
                    event.body,
                    event.isBase64Encoded ? "base64" : "utf8"
                )
                : Buffer.alloc(0);
        } catch {
            return respond(400, {
                error: "Invalid request body",
            });
        }

        // Total Budget accepts a maximum of 64 KB.
        // Budget Categories accepts a maximum of 16 KB.
        const maxSize = totalRoute ? 64 * 1024 : 16 * 1024;

        if (body.length > maxSize) {
            return respond(413, {
                error: "Request body too large",
            });
        }

        try {
            const result = await invokeNodeHttpHandler(method, path, body, async (request, response) => {
                const handled = totalRoute ? await handleBudgetTotal(request, response, cognitoSub) :
                    await handleBudgetCategories(request, response, cognitoSub);

                if (!handled) {
                    respond(404, { error: "Not found" });
                }
            });

            return {
                statusCode: result.statusCode,
                headers: {
                    ...corsHeaders,
                    ...result.headers,
                },
                body: result.body,
                isBase64Encoded: false,
            };
        } catch (error) {
            console.error("Budget Lambda request failed", error);

            return respond(500, {
                error: "Internal server error",
            });
        }
    };
}

export const handler = createBudgetHandler();
