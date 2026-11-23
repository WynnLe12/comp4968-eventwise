import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { EventsProxyEvent } from "../event-service/lambda/events";
import { ApiError } from "../expense-service/errors";
import { createCognitoAuthenticator } from "../shared/auth/cognito";
import { getDatabasePool } from "../shared/db/pool";
import {
  galleryShare, isEventId, isPhotoType, maxPhotoBytes, photoIdPattern, PhotoLinks,
  PhotosRepository, sharedEventId, uploadLifetime, type Photo,
} from "./photos";

const eventGallery = /^\/events\/([^/]+)\/photo-gallery(?:\/(pending|approve)(?:\/([^/]+))?)?$/;
const guestGallery = /^\/photo-gallery\/([^/]+)(?:\/(uploads|download)(?:\/([^/]+))?)?$/;
const notFound = () => new ApiError(404, "NOT_FOUND", "Gallery or photo not found.");

async function requireOwner(eventId: string, sub: string) {
  const [rows] = await getDatabasePool().execute<RowDataPacket[]>(
    "SELECT 1 FROM event_members WHERE event_id = ? AND CAST(cognito_sub AS BINARY) = CAST(? AS BINARY) AND role = 'OWNER' LIMIT 1",
    [eventId, sub],
  );
  if (!rows.length) throw new ApiError(403, "FORBIDDEN", "Only the event owner can manage this gallery.");
}

async function eventName(eventId: string): Promise<string> {
  const [rows] = await getDatabasePool().execute<RowDataPacket[]>("SELECT name FROM events WHERE event_id = ?", [eventId]);
  if (!rows[0]) throw notFound();
  return rows[0].name as string;
}

function uploadInput(event: EventsProxyEvent) {
  const invalid = () => new ApiError(400, "INVALID_IMAGE", "Choose a JPEG, PNG or WebP image up to 10 MB.");
  if (!event.body || event.body.length > 1024 || event.isBase64Encoded) throw invalid();
  let input: { contentType?: unknown; size?: unknown } | null;
  try { input = JSON.parse(event.body); } catch { throw invalid(); }
  if (!isPhotoType(input?.contentType) || typeof input.size !== "number" ||
      !Number.isSafeInteger(input.size) || input.size < 1 || input.size > maxPhotoBytes) throw invalid();
  return { contentType: input.contentType, size: input.size };
}

type GalleryEvent = EventsProxyEvent & { queryStringParameters?: Record<string, string | undefined> | null };

function gatewaySubject(event: GalleryEvent, apiId: string, pool: string | undefined, client: string | undefined): string {
  const context = event.requestContext;
  const claims = context?.authorizer?.claims;
  const issuer = pool && `https://cognito-idp.${pool.split("_")[0]}.amazonaws.com/${pool}`;
  // Owner methods must use the Cognito authorizer. Restrict invocation to the
  // intended API Gateway integration so callers cannot supply their own context.
  if (!pool || !client || context?.apiId !== apiId || !claims || claims.iss !== issuer ||
      claims.client_id !== client || claims.token_use !== "access" ||
      typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 128) {
    throw new ApiError(401, "UNAUTHENTICATED", "A valid Cognito access token is required.");
  }
  return claims.sub;
}

export function createGalleryHandler({
  repository = new PhotosRepository() as Pick<PhotosRepository, "get" | "create" | "list" | "approve">,
  links = new PhotoLinks() as Pick<PhotoLinks, "upload" | "thumbnail" | "download">,
  authenticate = createCognitoAuthenticator(),
  checkOwner = requireOwner,
  loadEventName = eventName,
  secret = process.env.PHOTO_SHARE_SECRET ?? "",
  origin = process.env.PHOTO_WEB_ORIGIN ?? "",
  gatewayApiId = process.env.PHOTO_GATEWAY_API_ID?.trim(),
  userPoolId = process.env.COGNITO_USER_POOL_ID,
  clientId = process.env.COGNITO_CLIENT_ID,
} = {}) {
  async function list(event: GalleryEvent, eventId: string, approval: Photo["approval"]) {
    const after = event.queryStringParameters?.after;
    if (after !== undefined && !photoIdPattern.test(after)) throw new ApiError(400, "INVALID_CURSOR", "Invalid page cursor.");
    const { photos, next } = await repository.list(eventId, approval, after);
    const items = await Promise.all(photos.map(async photo => ({
      id: photo.photoId, createdAt: photo.createdAt, thumbnailUrl: await links.thumbnail(photo),
    })));
    return { items, next };
  }

  return async (event: GalleryEvent) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
      headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    }
    const response = (statusCode: number, data?: unknown) => ({
      statusCode, headers, body: data === undefined ? "" : JSON.stringify(data),
    });
    const method = event.httpMethod;
    try {
      const ownerMatch = eventGallery.exec(event.path);
      const guestMatch = guestGallery.exec(event.path);
      if (!ownerMatch && !guestMatch) throw notFound();
      if (method === "OPTIONS") return response(204);
      if (ownerMatch) {
        const [, eventId, action, photoId] = ownerMatch;
        if (!isEventId(eventId)) throw notFound();
        const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
        const subject = gatewayApiId
          ? gatewaySubject(event, gatewayApiId, userPoolId, clientId)
          : await authenticate(authorization);
        await checkOwner(eventId, subject);
        if (method === "GET" && !action) return response(200, { share: galleryShare(eventId, secret) });
        if (method === "GET" && action === "pending" && !photoId) return response(200, await list(event, eventId, "PENDING"));
        if (method === "POST" && action === "approve" && photoIdPattern.test(photoId ?? "")) {
          if (!await repository.approve({ eventId, photoId })) throw notFound();
          return response(204);
        }
        throw notFound();
      }
      const [, token, action, photoId] = guestMatch!;
      const eventId = sharedEventId(token, secret);
      if (!eventId) throw notFound();
      const name = await loadEventName(eventId);
      if (method === "GET" && !action) return response(200, { name, ...await list(event, eventId, "APPROVED") });
      if (method === "POST" && action === "uploads" && !photoId) {
        const input = uploadInput(event);
        const now = Date.now();
        const photo: Photo = {
          ...input, eventId, photoId: randomUUID(), createdAt: new Date(now).toISOString(),
          uploadStatus: "ISSUED", approval: "PENDING", expiresAt: Math.floor(now / 1000) + 2 * 86400,
        };
        const signed = await links.upload(photo);
        await repository.create(photo);
        return response(201, { ...signed, expiresIn: uploadLifetime });
      }
      if (method === "GET" && action === "download" && photoIdPattern.test(photoId ?? "")) {
        const photo = await repository.get({ eventId, photoId });
        if (photo?.uploadStatus !== "READY" || photo.approval !== "APPROVED") throw notFound();
        return response(200, { url: await links.download(photo) });
      }
      throw notFound();
    } catch (error) {
      if (error instanceof ApiError) return response(error.status, { error: error.message });
      console.error("Gallery request failed", error instanceof Error ? error.name : "UnknownError");
      return response(500, { error: "The gallery is temporarily unavailable." });
    }
  };
}

export const handler = createGalleryHandler();
