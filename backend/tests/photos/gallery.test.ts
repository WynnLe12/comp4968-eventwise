import assert from "node:assert/strict";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand, PutObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { ApiError } from "../../expense-service/errors";
import { createGalleryHandler } from "../../photo-service/galleryApi";
import { galleryShare, maxPhotoBytes, originalKey, PhotoLinks, sharedEventId, thumbnailKey, type Photo } from "../../photo-service/photos";
import { createThumbnailHandler, makeThumbnail } from "../../photo-service/thumbnail";

const secret = "test-secret-with-at-least-thirty-two-bytes";
const key = { eventId: "101", photoId: "dcba2362-e587-48ea-81d6-81def10ef6ad" };
const share = galleryShare(key.eventId, secret);
const guest = `/photo-gallery/${share}`;
const owner = `/events/${key.eventId}/photo-gallery`;
const fixture: Photo = {
  ...key, contentType: "image/png", size: 100, createdAt: "2026-01-01T00:00:00Z",
  uploadStatus: "READY", approval: "PENDING",
};

test("the share signature binds the QR link to its event", () => {
  assert.equal(sharedEventId(share, secret), key.eventId);
  assert.equal(sharedEventId(share.replace("101-", "102-"), secret), undefined);
  assert.equal(sharedEventId(share + "x", secret), undefined);
});

test("only the owner can remove a photo and a failed storage deletion can be retried", async () => {
  const steps: string[] = [];
  let fail = true;
  const handler = createGalleryHandler({
    gatewayApiId: "",
    authenticate: async identity => identity ?? "",
    checkOwner: async (eventId, subject) => {
      if (eventId !== key.eventId || subject !== "owner") throw new ApiError(403, "FORBIDDEN", "Owner only.");
    },
    deletion: {
      repository: {
        beginDeletion: async candidate => { assert.deepEqual(candidate, key); steps.push("hide"); return true; },
        completeDeletion: async () => { steps.push("remove metadata"); },
      },
      storage: {
        deleteObjects: async candidate => {
          assert.deepEqual(candidate, key);
          steps.push("delete objects");
          if (fail) throw new Error("S3 temporarily unavailable");
        },
      },
    },
  });
  const request = { httpMethod: "DELETE", path: `${owner}/photos/${key.photoId}` };
  assert.equal((await handler({ ...request, headers: { Authorization: "co-planner" } })).statusCode, 403);
  assert.deepEqual(steps, []);
  const ownerRequest = { ...request, headers: { Authorization: "owner" } };
  assert.equal((await handler(ownerRequest)).statusCode, 500);
  assert.deepEqual(steps, ["hide", "delete objects"]);
  fail = false;
  assert.equal((await handler(ownerRequest)).statusCode, 204);
  assert.deepEqual(steps, ["hide", "delete objects", "hide", "delete objects", "remove metadata"]);
});

test("shared gateway mode requires Cognito access-token claims from the configured API", async () => {
  const apiId = "galleryapi";
  const userPoolId = "us-west-2_fixture";
  const clientId = "organizer-client";
  const handler = createGalleryHandler({
    secret, gatewayApiId: apiId, userPoolId, clientId,
    authenticate: async () => { assert.fail("No direct token verification in shared gateway mode"); },
    checkOwner: async (eventId, sub) => {
      assert.equal(eventId, key.eventId);
      if (sub !== "owner") throw new ApiError(403, "FORBIDDEN", "Owner only.");
    },
  });
  const claims = {
    sub: "owner", token_use: "access", client_id: clientId,
    iss: `https://cognito-idp.us-west-2.amazonaws.com/${userPoolId}`,
  };
  const request = { httpMethod: "GET", path: owner, headers: { Authorization: "Bearer unverified" } };
  const invoke = (api: string, candidate: typeof claims) =>
    handler({ ...request, requestContext: { apiId: api, authorizer: { claims: candidate } } });

  assert.equal((await handler(request)).statusCode, 401);
  assert.equal((await invoke("otherapi", claims)).statusCode, 401);
  assert.equal((await invoke(apiId, { ...claims, token_use: "id" })).statusCode, 401);
  assert.equal((await invoke(apiId, { ...claims, client_id: "other-client" })).statusCode, 401);
  assert.equal((await invoke(apiId, { ...claims, iss: "https://other.example" })).statusCode, 401);
  assert.equal((await invoke(apiId, { ...claims, sub: "coplanner" })).statusCode, 403);
  assert.equal(JSON.parse((await invoke(apiId, claims)).body).share, share);
});

test("guests upload without Cognito and only owners can publish a ready photo", async () => {
  const photos = new Map([[fixture.photoId, { ...fixture }]]);
  const requests: string[] = [];
  const handler = createGalleryHandler({
    secret,
    gatewayApiId: "",
    loadEventName: async eventId => {
      if (eventId !== key.eventId) throw new ApiError(404, "NOT_FOUND", "Event not found.");
      return "Test event";
    },
    authenticate: async header => {
      if (!header) throw new ApiError(401, "UNAUTHENTICATED", "Sign in.");
      return header;
    },
    checkOwner: async (eventId, sub) => {
      if (sub !== "owner" || eventId !== key.eventId) throw new ApiError(403, "FORBIDDEN", "Owner only.");
    },
    repository: {
      get: async ({ eventId, photoId }) => eventId === key.eventId ? photos.get(photoId) : undefined,
      create: async photo => { photos.set(photo.photoId, photo); },
      list: async (eventId, approval) => ({
        photos: [...photos.values()].filter(photo =>
          photo.eventId === eventId && photo.uploadStatus === "READY" && photo.approval === approval),
        next: undefined,
      }),
      approve: async ({ photoId }) => {
        const photo = photos.get(photoId);
        if (photo?.uploadStatus !== "READY") return false;
        photo.approval = "APPROVED";
        return true;
      },
    },
    links: {
      upload: async photo => { requests.push("upload"); return { url: originalKey(photo), headers: { "Content-Type": photo.contentType, "If-None-Match": "*" } }; },
      thumbnail: async photo => { requests.push("thumbnail"); return thumbnailKey(photo); },
      download: async photo => { requests.push("download"); return originalKey(photo); },
    },
  });
  const request = (httpMethod: string, path: string, authorization?: string, body?: unknown) =>
    handler({ httpMethod, path, headers: { Authorization: authorization }, body: JSON.stringify(body) });

  assert.equal((await request("GET", owner)).statusCode, 401);
  assert.equal((await request("GET", `/photo-gallery/${galleryShare("102", secret)}`)).statusCode, 404);
  assert.deepEqual(JSON.parse((await request("GET", guest)).body), { name: "Test event", items: [] });
  assert.equal((await request("GET", `${guest}/download/${key.photoId}`)).statusCode, 404);
  assert.deepEqual(requests, []);
  assert.equal((await request("POST", `${owner}/approve/${key.photoId}`, "co-planner")).statusCode, 403);
  assert.equal((await request("POST", `/events/102/photo-gallery/approve/${key.photoId}`, "owner")).statusCode, 403);
  assert.equal(JSON.parse((await request("GET", owner, "owner")).body).share, share);
  assert.equal(JSON.parse((await request("GET", `${owner}/pending`, "owner")).body).items[0].id, key.photoId);

  for (const input of [{ contentType: "image/svg+xml", size: 20 }, { contentType: "image/png", size: maxPhotoBytes + 1 }]) {
    assert.equal((await request("POST", `${guest}/uploads`, undefined, input)).statusCode, 400);
  }
  const upload = await request("POST", `${guest}/uploads`, undefined, { contentType: "image/png", size: 20 });
  assert.equal(upload.statusCode, 201);
  const issued = [...photos.values()].find(photo => photo.uploadStatus === "ISSUED");
  assert.equal(issued?.approval, "PENDING");
  assert.equal((await request("POST", `${owner}/approve/${issued?.photoId}`, "owner")).statusCode, 404);
  assert.equal((await request("GET", `${guest}/download/${issued?.photoId}`)).statusCode, 404);

  assert.equal((await request("POST", `${owner}/approve/${key.photoId}`, "owner")).statusCode, 204);
  assert.deepEqual(JSON.parse((await request("GET", `${owner}/pending`, "owner")).body).items, []);
  assert.equal(JSON.parse((await request("GET", guest)).body).items[0].id, key.photoId);
  assert.equal(JSON.parse((await request("GET", `${guest}/download/${key.photoId}`)).body).url, originalKey(fixture));
});

test("S3 presigning binds expiry, size, MIME type and the no-overwrite header", async () => {
  const s3 = new S3Client({
    region: "us-west-2", credentials: { accessKeyId: "example", secretAccessKey: "example" },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const links = new PhotoLinks("eventwise-gallery-fixture", s3);
  const signed = await links.upload(fixture);
  const url = new URL(signed.url);
  assert.equal(url.pathname, `/${originalKey(fixture)}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "120");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host;if-none-match");
  assert.deepEqual(signed.headers, { "Content-Type": "image/png", "If-None-Match": "*" });
  assert.match(new URL(await links.download(fixture)).searchParams.get("response-content-disposition") ?? "", /^attachment;/);
});

test("a thumbnail is written before the upload becomes ready and duplicate notifications are harmless", async () => {
  const source = await sharp({ create: { width: 960, height: 720, channels: 3, background: "blue" } }).png().toBuffer();
  assert.equal(await makeThumbnail(source, "jpeg"), undefined);
  assert.equal(await makeThumbnail(Buffer.from("not an image"), "png"), undefined);

  const client = new S3Client({});
  const bucket = "fixture-bucket";
  const photo = { ...fixture, size: source.length, uploadStatus: "ISSUED" } as Photo;
  const written: PutObjectCommand[] = [];
  let tagged = false;
  const stub = async (command: unknown) => {
    if (command instanceof GetObjectCommand) return {
      ContentLength: source.length, ContentType: photo.contentType,
      Body: { transformToByteArray: async () => source },
    };
    if (command instanceof PutObjectCommand) written.push(command);
    else if (command instanceof PutObjectTaggingCommand) tagged = true;
    else throw new Error("Unexpected S3 call");
    return {};
  };
  client.send = stub as typeof client.send;
  const handler = createThumbnailHandler({
    client, bucket,
    repository: {
      get: async () => photo,
      finish: async (_key, status) => {
        if (status === "READY") assert.equal(written.length, 1);
        photo.uploadStatus = status;
      },
    },
  });
  const event = { Records: [{ s3: { bucket: { name: bucket }, object: { key: encodeURIComponent(originalKey(photo)) } } }] };
  await handler(event);
  await handler(event);
  assert.equal(photo.uploadStatus, "READY");
  assert.equal(photo.approval, "PENDING");
  assert.equal(written.length, 1);
  assert.equal(written[0].input.Key, thumbnailKey(photo));
  const { width, height, format } = await sharp(written[0].input.Body as Buffer).metadata();
  assert.deepEqual({ width, height, format }, { width: 480, height: 360, format: "jpeg" });

  photo.uploadStatus = "ISSUED";
  photo.contentType = "image/jpeg";
  await handler(event);
  assert.equal(photo.uploadStatus, "FAILED");
  assert.equal(tagged, true);
  assert.equal(written.length, 1);
});
