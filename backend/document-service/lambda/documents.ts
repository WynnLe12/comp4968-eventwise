import { verifyToken } from "../../shared/auth/verifyToken";
import { handleDocumentRequest } from "../handlers/documentHandler";

interface DocumentsProxyEvent {
    httpMethod: string;
    path: string;
    headers?: Record<string, string | undefined> | null;
    body?: string | null;
    isBase64Encoded?: boolean;
}

interface DocumentsProxyResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    isBase64Encoded: false;
}

const corsHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin":
        process.env.DOCUMENTS_CORS_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Methods":
        "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type,Authorization",
};

function respond(
    statusCode: number,
    body: object,
): DocumentsProxyResponse {
    return {
        statusCode,
        headers: corsHeaders,
        body: JSON.stringify(body),
        isBase64Encoded: false,
    };
}

function getBearerToken(
    headers?: Record<string, string | undefined> | null,
): string | null {
    const authorization = Object.entries(headers ?? {})
        .find(([name]) => name.toLowerCase() === "authorization")?.[1];

    const match = /^Bearer ([^\s]+)$/i.exec(
        authorization?.trim() ?? "",
    );

    return match?.[1] ?? null;
}

function isDocumentRoute(path: string): boolean {
    return (
        /^\/events\/[^/]+\/documents$/.test(path) ||
        /^\/events\/[^/]+\/documents\/upload-url$/.test(path) ||
        /^\/events\/[^/]+\/documents\/complete$/.test(path) ||
        /^\/events\/[^/]+\/documents\/[^/]+\/download$/.test(path) ||
        /^\/events\/[^/]+\/documents\/[^/]+$/.test(path)
    );
}

export function createDocumentsHandler(
    authenticate: (token: string) => Promise<string> = verifyToken,
) {
    return async function handler(
        event: DocumentsProxyEvent,
    ): Promise<DocumentsProxyResponse> {
        const method = event.httpMethod;
        const path = event.path;

        if (!method || !path || !isDocumentRoute(path)) {
            return respond(404, {
                error: "Document endpoint not found.",
            });
        }

        if (method === "OPTIONS") {
            return {
                ...respond(204, {}),
                body: "",
            };
        }

        if (!["GET", "POST", "DELETE"].includes(method)) {
            return respond(405, {
                error: "Method not allowed.",
            });
        }

        const token = getBearerToken(event.headers);

        if (!token) {
            return respond(401, {
                error: "Missing authentication token.",
            });
        }

        let userSub: string;

        try {
            userSub = await authenticate(token);
        } catch {
            return respond(401, {
                error: "Invalid or expired authentication token.",
            });
        }

        let body: unknown;

        if (event.body) {
            let rawBody: Buffer;

            try {
                rawBody = Buffer.from(
                    event.body,
                    event.isBase64Encoded ? "base64" : "utf8",
                );
            } catch {
                return respond(400, {
                    error: "Invalid request body.",
                });
            }

            if (rawBody.length > 16 * 1024) {
                return respond(413, {
                    error: "Request body too large.",
                });
            }

            try {
                body = JSON.parse(rawBody.toString("utf8"));
            } catch {
                return respond(400, {
                    error: "Invalid JSON body.",
                });
            }
        }

        try {
            const result = await handleDocumentRequest({
                method,
                path,
                body,
                userSub,
            });

            return respond(result.statusCode, result.body);
        } catch (error) {
            console.error("Documents Lambda failed:", error);

            return respond(500, {
                error: "Internal server error.",
            });
        }
    };
}

export const handler = createDocumentsHandler();
