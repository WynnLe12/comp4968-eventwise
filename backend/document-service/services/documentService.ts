import { createHash, randomUUID } from "node:crypto";
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError } from "../../expense-service/errors";
import {
    DocumentRepository,
    type DocumentRecord,
} from "../repositories/documentRepository";
import {
    createUploadToken,
    verifyUploadToken,
} from "./uploadToken";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const URL_EXPIRATION = 300; // 5 minutes

const ALLOWED_TYPES = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export interface UploadRequest {
    filename: string;
    contentType: string;
    sizeBytes: number;
}

export interface PendingUpload {
    uploadToken: string;
}

export class DocumentService {
    private readonly s3: S3Client;
    private readonly repository: DocumentRepository;
    private readonly bucket: string;

    constructor(
        repository = new DocumentRepository(),
        s3 = new S3Client({}),
        bucket = process.env.DOCUMENTS_BUCKET_NAME ?? "",
    ) {
        this.repository = repository;
        this.s3 = s3;
        this.bucket = bucket;
    }

    private requireBucket(): void {
        if (!this.bucket) {
            throw new ApiError(
                503,
                "SERVICE_UNAVAILABLE",
                "Document storage is not configured.",
            );
        }
    }

    private validateId(value: string): void {
        if (!/^[1-9]\d*$/.test(value) ||
            BigInt(value) > 18446744073709551615n) {
            throw new ApiError(
                400,
                "INVALID_ID",
                "Invalid ID.",
            );
        }
    }

    private async authorize(
        eventId: string,
        userSub: string,
    ): Promise<void> {
        this.validateId(eventId);

        if (!userSub) {
            throw new ApiError(
                401,
                "UNAUTHENTICATED",
                "Authentication is required.",
            );
        }

        const role = await this.repository.getMemberRole(
            eventId,
            userSub,
        );

        if (!role) {
            throw new ApiError(
                403,
                "FORBIDDEN",
                "You do not have access to this event.",
            );
        }
    }

    private validateUpload(input: UploadRequest): void {
        if (
            !input.filename ||
            input.filename.length > 255 ||
            /[/\\\x00-\x1f]/.test(input.filename)
        ) {
            throw new ApiError(
                400,
                "INVALID_FILENAME",
                "Invalid filename.",
            );
        }

        if (!ALLOWED_TYPES.has(input.contentType)) {
            throw new ApiError(
                400,
                "INVALID_FILE_TYPE",
                "Only PDF, JPG, PNG and DOCX files are supported.",
            );
        }

        if (
            !Number.isSafeInteger(input.sizeBytes) ||
            input.sizeBytes <= 0 ||
            input.sizeBytes > MAX_FILE_SIZE
        ) {
            throw new ApiError(
                400,
                "INVALID_FILE_SIZE",
                "File must be between 1 byte and 10 MB.",
            );
        }
    }

    // Step 1 of uploading: authorize and generate a temporary S3 URL.
    async createUploadUrl(
        eventId: string,
        userSub: string,
        input: UploadRequest,
    ) {
        // Verify the user belongs to this event.
        await this.authorize(eventId, userSub);
        this.requireBucket();
        this.validateUpload(input);

        // Generate a unique S3 object key.
        const key = `events/${eventId}/pending/${randomUUID()}`;

        const encodedFilename = encodeURIComponent(input.filename);

        // Create a presigned POST with an S3-enforced size limit.
        const presignedPost = await createPresignedPost(this.s3, {
            Bucket: this.bucket,
            Key: key,
            Expires: URL_EXPIRATION,

            Fields: {
                "Content-Type": input.contentType,
                "x-amz-meta-original-filename": encodedFilename,
                "x-amz-meta-uploaded-by": userSub,
                "x-amz-tagging": "upload-status=temporary",
            },

            Conditions: [
                ["content-length-range", 1, MAX_FILE_SIZE + 4096],
                ["eq", "$Content-Type", input.contentType],
                ["eq", "$x-amz-meta-original-filename", encodedFilename],
                ["eq", "$x-amz-meta-uploaded-by", userSub],
                ["eq", "$x-amz-tagging", "upload-status=temporary"],
            ],
        });

        // Sign the authorized upload information.
        const uploadToken = createUploadToken({
            eventId,
            userSub,
            key,
            filename: input.filename,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            expiresAt: Date.now() + URL_EXPIRATION * 1000,
        });

        return {
            uploadUrl: presignedPost.url,
            uploadFields: presignedPost.fields,
            uploadToken,
            expiresIn: URL_EXPIRATION,
        };
    }

    // Step 2 of uploading: verify the S3 object before saving metadata.

    async completeUpload(
        eventId: string,
        userSub: string,
        input: PendingUpload,
    ) {
        await this.authorize(eventId, userSub);
        this.requireBucket();

        const upload = verifyUploadToken(
            input.uploadToken,
            eventId,
            userSub,
        );

        this.validateUpload({
            filename: upload.filename,
            contentType: upload.contentType,
            sizeBytes: upload.sizeBytes,
        });

        // Derive a permanent key from the authorized temporary key.
        const finalKey = upload.key.replace(
            "/pending/",
            "/documents/",
        );

        // Return the existing document when completion is retried.
        const existing = await this.repository.getByS3Key(
            eventId,
            finalKey,
        );

        if (existing) {
            if (
                existing.uploaded_by_sub !== userSub ||
                existing.original_filename !== upload.filename ||
                existing.content_type !== upload.contentType ||
                Number(existing.size_bytes) !== upload.sizeBytes
            ) {
                throw new ApiError(
                    409,
                    "UPLOAD_CONFLICT",
                    "Document registration does not match the upload.",
                );
            }

            return { documentId: String(existing.document_id) };
        }

        // Download the temporary object and validate its actual contents.
        let fileBytes: Uint8Array;

        try {
            const object = await this.s3.send(
                new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: upload.key,
                }),
            );

            if (
                object.ContentLength !== upload.sizeBytes ||
                object.ContentType !== upload.contentType ||
                object.Metadata?.["uploaded-by"] !== upload.userSub ||
                object.Metadata?.["original-filename"] !==
                encodeURIComponent(upload.filename) ||
                !object.Body
            ) {
                throw new ApiError(
                    400,
                    "UPLOAD_MISMATCH",
                    "Uploaded file does not match its metadata.",
                );
            }

            fileBytes = await object.Body.transformToByteArray();

            if (fileBytes.byteLength !== upload.sizeBytes) {
                throw new ApiError(
                    400,
                    "UPLOAD_MISMATCH",
                    "Uploaded file size does not match.",
                );
            }
        } catch (error) {
            if (error instanceof ApiError) throw error;

            throw new ApiError(
                400,
                "UPLOAD_NOT_FOUND",
                "Uploaded file could not be retrieved from S3.",
            );
        }

        // Hash verified bytes on the backend; browser metadata is never trusted.
        const contentSha256 = createHash("sha256").update(fileBytes).digest("hex");

        // Conditional PUT makes finalized objects immutable: no browser POST
        // can write this key, and another finalization cannot overwrite it.
        try {
            await this.s3.send(
                new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: finalKey,
                    Body: fileBytes,
                    ContentType: upload.contentType,
                    Metadata: {
                        "original-filename": encodeURIComponent(upload.filename),
                        "uploaded-by": userSub,
                    },
                    IfNoneMatch: "*",
                }),
            );
        } catch (error) {
            const errorName = error instanceof Error ? error.name : "";
            if (errorName !== "PreconditionFailed" &&
                errorName !== "ConditionalRequestConflict") {
                throw error;
            }

            // If a previous request wrote S3 but failed before the RDS INSERT,
            // recover only when the final object is byte-for-byte identical.
            // A competing or mismatching object must never be registered.
            let finalObject;
            try {
                finalObject = await this.s3.send(new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: finalKey,
                }));
            } catch {
                throw new ApiError(409, "UPLOAD_CONFLICT", "Document finalization is in progress. Please retry.");
            }
            if (!finalObject.Body ||
                finalObject.ContentLength !== upload.sizeBytes ||
                finalObject.ContentType !== upload.contentType ||
                finalObject.Metadata?.["uploaded-by"] !== userSub ||
                finalObject.Metadata?.["original-filename"] !== encodeURIComponent(upload.filename)) {
                throw new ApiError(409, "UPLOAD_CONFLICT", "Final document does not match this upload.");
            }
            const actual = await finalObject.Body.transformToByteArray();
            if (createHash("sha256").update(actual).digest("hex") !== contentSha256) {
                throw new ApiError(409, "UPLOAD_CONFLICT", "Final document contents do not match this upload.");
            }
        }

        let documentId: string;
        try {
            documentId = await this.repository.create({
                eventId,
                uploadedBySub: userSub,
                s3ObjectKey: finalKey,
                originalFilename: upload.filename,
                contentType: upload.contentType,
                sizeBytes: upload.sizeBytes,
                contentSha256,
            });
        } catch (error) {
            // The finalized object must not be deleted automatically: a
            // concurrent completion may have registered it successfully.
            console.error("DOCUMENT_FINALIZED_NOT_REGISTERED", {
                eventId, bucket: this.bucket, key: finalKey,
                error: error instanceof Error ? error.message : "Unknown database error",
            });
            throw error;
        }

        // Best-effort cleanup; the S3 lifecycle rule handles failures here.
        try {
            await this.s3.send(new DeleteObjectCommand({
                Bucket: this.bucket, Key: upload.key,
            }));
        } catch (error) {
            console.warn("DOCUMENT_PENDING_CLEANUP", {
                eventId, bucket: this.bucket, key: upload.key,
                error: error instanceof Error ? error.message : "Unknown S3 error",
            });
        }

        return { documentId };
    }

    // Retrieve document metadata for the selected event.
    async listDocuments(eventId: string, userSub: string) {
        await this.authorize(eventId, userSub);

        const documents = await this.repository.listByEvent(eventId);

        return documents.map((document) => this.toPublicDocument(document));
    }

    // Generate a temporary URL for viewing or downloading a document.
    async getDownloadUrl(
        eventId: string,
        documentId: string,
        userSub: string,
    ) {
        await this.authorize(eventId, userSub);
        this.validateId(documentId);
        this.requireBucket();

        const document = await this.repository.getById(
            eventId,
            documentId,
        );

        if (!document) {
            throw new ApiError(
                404,
                "DOCUMENT_NOT_FOUND",
                "Document not found.",
            );
        }

        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: document.s3_object_key,
        });

        const downloadUrl = await getSignedUrl(this.s3, command, {
            expiresIn: URL_EXPIRATION,
        });

        return {
            document: this.toPublicDocument(document),
            downloadUrl,
            expiresIn: URL_EXPIRATION,
        };
    }

    // Delete an event document if it is not used by F15.
    async deleteDocument(
        eventId: string,
        documentId: string,
        userSub: string,
    ) {
        // Step 1: Verify the user's event membership.
        await this.authorize(eventId, userSub);
        this.validateId(documentId);
        this.requireBucket();

        // Step 2: Retrieve the document metadata.
        const document = await this.repository.getById(
            eventId,
            documentId,
        );

        if (!document) {
            throw new ApiError(
                404,
                "DOCUMENT_NOT_FOUND",
                "Document not found.",
            );
        }

        // Step 3: Protect documents referenced by F15.
        const isUsed = await this.repository.isUsedByBudgetDraft(
            eventId,
            documentId,
        );

        if (isUsed) {
            throw new ApiError(
                409,
                "DOCUMENT_IN_USE",
                "This document is used by an AI budget draft and cannot be deleted.",
            );
        }

        // Step 4: Remove metadata only if no F15 references exist.
        const deleted = await this.repository.deleteById(
            eventId,
            documentId,
        );

        if (!deleted) {
            throw new ApiError(
                409,
                "DELETE_CONFLICT",
                "Document could not be deleted. Please refresh and try again.",
            );
        }

        // Step 5: Remove the S3 object.
        try {
            await this.s3.send(
                new DeleteObjectCommand({
                    Bucket: this.bucket,
                    Key: document.s3_object_key,
                }),
            );

            return {
                deleted: true,
                storageCleanupPending: false,
            };
        } catch (error) {
            // MySQL metadata was deleted, but the S3 object remains.
            // Log the object location for manual cleanup.
            console.error("DOCUMENT_S3_CLEANUP_REQUIRED", {
                eventId,
                documentId,
                bucket: this.bucket,
                key: document.s3_object_key,
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown S3 deletion error",
            });

            return {
                deleted: true,
                storageCleanupPending: true,
            };
        }
    }

    private toPublicDocument(document: DocumentRecord) {
        return {
            documentId: String(document.document_id),
            eventId: String(document.event_id),
            filename: document.original_filename,
            contentType: document.content_type,
            sizeBytes: String(document.size_bytes),
            uploadedAt: document.created_at,
        };
    }
}
