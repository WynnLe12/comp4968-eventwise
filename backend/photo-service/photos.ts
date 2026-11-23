import { createHmac, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "../shared/db/dynamodb";

export const maxPhotoBytes = 10 * 1024 * 1024;
export const photoFormats = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type PhotoType = keyof typeof photoFormats;

export function isPhotoType(value: unknown): value is PhotoType {
  return typeof value === "string" && Object.hasOwn(photoFormats, value);
}

export function isEventId(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

export const photoIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const uploadLifetime = 120;
const readLifetime = 900;

export interface Photo {
  eventId: string;
  photoId: string;
  contentType: PhotoType;
  size: number;
  createdAt: string;
  uploadStatus: "ISSUED" | "READY" | "FAILED";
  approval: "PENDING" | "APPROVED";
  expiresAt?: number;
}

type PhotoKey = Pick<Photo, "eventId" | "photoId">;
export const originalKey = ({ eventId, photoId }: PhotoKey) => `originals/${eventId}/${photoId}`;
export const thumbnailKey = ({ eventId, photoId }: PhotoKey) => `thumbnails/${eventId}/${photoId}.jpg`;

export function galleryShare(eventId: string, secret: string): string {
  if (Buffer.byteLength(secret) < 32) throw new Error("Gallery secret is missing or too short");
  const signature = createHmac("sha256", secret).update(`eventwise-gallery:${eventId}`).digest("base64url");
  return `${eventId}-${signature}`;
}

export function sharedEventId(token: string, secret: string): string | undefined {
  const match = /^([0-9]{1,20})-[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match || !isEventId(match[1])) return undefined;
  if (timingSafeEqual(Buffer.from(token), Buffer.from(galleryShare(match[1], secret)))) return match[1];
}

export function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export class PhotosRepository {
  constructor(private readonly table = process.env.PHOTOS_TABLE ?? "") {}

  async get(key: PhotoKey): Promise<Photo | undefined> {
    const { Item } = await getDocumentClient().send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    return Item as Photo | undefined;
  }

  async create(photo: Photo) {
    await getDocumentClient().send(new PutCommand({
      TableName: this.table, Item: photo, ConditionExpression: "attribute_not_exists(photoId)",
    }));
  }

  async list(eventId: string, approval: Photo["approval"], after?: string) {
    const { Items, LastEvaluatedKey } = await getDocumentClient().send(new QueryCommand({
      TableName: this.table, ConsistentRead: true, Limit: 40,
      KeyConditionExpression: "eventId = :eventId",
      FilterExpression: "uploadStatus = :ready AND approval = :approval",
      ExpressionAttributeValues: { ":eventId": eventId, ":ready": "READY", ":approval": approval },
      ExclusiveStartKey: after ? { eventId, photoId: after } : undefined,
    }));
    return { photos: (Items ?? []) as Photo[], next: LastEvaluatedKey?.photoId as string | undefined };
  }

  async approve(key: PhotoKey): Promise<boolean> {
    try {
      await getDocumentClient().send(new UpdateCommand({
        TableName: this.table, Key: key,
        ConditionExpression: "uploadStatus = :ready",
        UpdateExpression: "SET approval = :approved",
        ExpressionAttributeValues: { ":ready": "READY", ":approved": "APPROVED" },
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async finish({ eventId, photoId }: PhotoKey, status: "READY" | "FAILED") {
    try {
      await getDocumentClient().send(new UpdateCommand({
        TableName: this.table, Key: { eventId, photoId },
        ConditionExpression: "uploadStatus = :issued",
        UpdateExpression: status === "READY" ? "SET uploadStatus = :status REMOVE expiresAt" : "SET uploadStatus = :status",
        ExpressionAttributeValues: { ":issued": "ISSUED", ":status": status },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
  }
}

export const photoS3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });

export class PhotoLinks {
  constructor(private readonly bucket = process.env.PHOTOS_BUCKET ?? "", private readonly client = photoS3) {}

  async upload(photo: Photo) {
    const headers = { "Content-Type": photo.contentType, "If-None-Match": "*" };
    const url = await getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket, Key: originalKey(photo), ContentType: photo.contentType,
      ContentLength: photo.size, IfNoneMatch: headers["If-None-Match"],
    }), { expiresIn: uploadLifetime, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
    return { url, headers };
  }

  thumbnail(photo: Photo) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: thumbnailKey(photo), ResponseCacheControl: "private, no-store",
    }), { expiresIn: readLifetime });
  }

  download(photo: Photo) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: originalKey(photo), ResponseCacheControl: "private, no-store",
      ResponseContentType: photo.contentType,
      ResponseContentDisposition: `attachment; filename="event-photo-${photo.photoId}.${photoFormats[photo.contentType] === "jpeg" ? "jpg" : photoFormats[photo.contentType]}"`,
    }), { expiresIn: 120 });
  }
}
