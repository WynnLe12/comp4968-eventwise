import {
    createHmac,
    timingSafeEqual,
} from "node:crypto";
import { ApiError } from "../../expense-service/errors";

export interface UploadTokenPayload {
    eventId: string;
    userSub: string;
    key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    expiresAt: number;
}

function getSigningSecret(): string {
    const secret = process.env.DOCUMENTS_UPLOAD_SIGNING_SECRET;

    if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
        throw new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "Document upload signing is not configured.",
        );
    }

    return secret;
}

function sign(data: string): Buffer {
    return createHmac("sha256", getSigningSecret())
        .update(data)
        .digest();
}

export function createUploadToken(
    payload: UploadTokenPayload,
): string {
    const encoded = Buffer.from(
        JSON.stringify(payload),
        "utf8",
    ).toString("base64url");

    const signature = sign(encoded).toString("base64url");

    return `${encoded}.${signature}`;
}

export function verifyUploadToken(
    token: string,
    eventId: string,
    userSub: string,
): UploadTokenPayload {
    if (
        typeof token !== "string" ||
        token.length > 4096
    ) {
        throw new ApiError(
            403,
            "INVALID_UPLOAD_TOKEN",
            "Invalid upload token.",
        );
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
        throw new ApiError(
            403,
            "INVALID_UPLOAD_TOKEN",
            "Invalid upload token.",
        );
    }

    const [encoded, providedSignature] = parts;

    if (
        !/^[A-Za-z0-9_-]+$/.test(encoded) ||
        !/^[A-Za-z0-9_-]+$/.test(providedSignature)
    ) {
        throw new ApiError(
            403,
            "INVALID_UPLOAD_TOKEN",
            "Invalid upload token.",
        );
    }

    const expected = sign(encoded);
    const provided = Buffer.from(
        providedSignature,
        "base64url",
    );

    if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
    ) {
        throw new ApiError(
            403,
            "INVALID_UPLOAD_TOKEN",
            "Invalid upload token.",
        );
    }

    let payload: UploadTokenPayload;

    try {
        payload = JSON.parse(
            Buffer.from(encoded, "base64url").toString("utf8"),
        );
    } catch {
        throw new ApiError(
            403,
            "INVALID_UPLOAD_TOKEN",
            "Invalid upload token.",
        );
    }

    if (
        !payload ||
        payload.eventId !== eventId ||
        payload.userSub !== userSub ||
        typeof payload.key !== "string" ||
        typeof payload.filename !== "string" ||
        typeof payload.contentType !== "string" ||
        !Number.isSafeInteger(payload.sizeBytes) ||
        !Number.isSafeInteger(payload.expiresAt) ||
        payload.expiresAt <= Date.now() ||
        !/^events\/[1-9]\d*\/pending\/[0-9a-f-]{36}$/.test(
            payload.key,
        ) ||
        !payload.key.startsWith(
            `events/${eventId}/pending/`,
        )
    ) {
        throw new ApiError(
            403,
            "INVALID_UPLOAD_TOKEN",
            "Invalid or expired upload token.",
        );
    }

    return payload;
}
