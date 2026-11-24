import { ApiError } from "../../expense-service/errors";
import {
    DocumentService,
    type UploadRequest,
    type PendingUpload,
} from "../services/documentService";

interface DocumentRequest {
    method: string;
    path: string;
    body?: unknown;
    userSub: string;
}

interface DocumentResponse {
    statusCode: number;
    body: object;
}

function isObject(
    value: unknown,
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function parseUploadRequest(value: unknown): UploadRequest {
    if (
        !isObject(value) ||
        typeof value.filename !== "string" ||
        typeof value.contentType !== "string" ||
        typeof value.sizeBytes !== "number"
    ) {
        throw new ApiError(
            400,
            "INVALID_REQUEST",
            "Invalid upload request.",
        );
    }

    return {
        filename: value.filename,
        contentType: value.contentType,
        sizeBytes: value.sizeBytes,
    };
}

function parseCompletionRequest(value: unknown): PendingUpload {
    if (
        !isObject(value) ||
        typeof value.uploadToken !== "string" ||
        !value.uploadToken
    ) {
        throw new ApiError(
            400,
            "INVALID_REQUEST",
            "A valid upload token is required.",
        );
    }

    return {
        uploadToken: value.uploadToken,
    };
}

export async function handleDocumentRequest(
    request: DocumentRequest,
    service = new DocumentService(),
): Promise<DocumentResponse> {
    const { method, path, body, userSub } = request;

    const listRoute = /^\/events\/([^/]+)\/documents$/.exec(path);

    const uploadRoute = /^\/events\/([^/]+)\/documents\/upload-url$/.exec(path);

    const completeRoute = /^\/events\/([^/]+)\/documents\/complete$/.exec(path);

    const downloadRoute = /^\/events\/([^/]+)\/documents\/([^/]+)\/download$/.exec(path);

    const deleteRoute = /^\/events\/([^/]+)\/documents\/([^/]+)$/.exec(path);

    try {
        if (listRoute && method === "GET") {
            const documents = await service.listDocuments(
                listRoute[1],
                userSub,
            );

            return {
                statusCode: 200,
                body: { documents },
            };
        }

        if (uploadRoute && method === "POST") {
            const input = parseUploadRequest(body);

            const result = await service.createUploadUrl(
                uploadRoute[1],
                userSub,
                input,
            );

            return {
                statusCode: 200,
                body: result,
            };
        }

        if (completeRoute && method === "POST") {
            const input = parseCompletionRequest(body);

            const result = await service.completeUpload(
                completeRoute[1],
                userSub,
                input,
            );

            return {
                statusCode: 201,
                body: {
                    ...result,
                    message: "Document uploaded successfully.",
                },
            };
        }

        if (downloadRoute && method === "GET") {
            const result = await service.getDownloadUrl(
                downloadRoute[1],
                downloadRoute[2],
                userSub,
            );

            return {
                statusCode: 200,
                body: result,
            };
        }

        if (deleteRoute && method === "DELETE") {
            const result = await service.deleteDocument(
                deleteRoute[1],
                deleteRoute[2],
                userSub,
            );

            return {
                statusCode: 200,
                body: result,
            };
        }

        return {
            statusCode: 404,
            body: { error: "Document endpoint not found." },
        };
    } catch (error: unknown) {
        if (error instanceof ApiError) {
            return {
                statusCode: error.status,
                body: {
                    error: error.message,
                    code: error.code,
                },
            };
        }

        console.error("Document request failed", error);

        return {
            statusCode: 500,
            body: {
                error: "Internal server error.",
            },
        };
    }
}
