import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, PutObjectTaggingCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { isEventId, maxPhotoBytes, photoFormats, photoIdPattern, photoS3, PhotosRepository, thumbnailKey } from "./photos";

interface S3Notification {
  Records?: Array<{ s3: { bucket: { name: string }; object: { key: string } } }>;
}

export async function makeThumbnail(bytes: Uint8Array, format: string): Promise<Buffer | undefined> {
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) return;
    return await image.rotate().resize(480, 480, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return undefined;
  }
}

export function createThumbnailHandler({
  repository = new PhotosRepository() as Pick<PhotosRepository, "get" | "finish">,
  client = photoS3 as Pick<typeof photoS3, "send">,
  bucket = process.env.PHOTOS_BUCKET ?? "",
} = {}) {
  return async (event: S3Notification) => {
    for (const record of event.Records ?? []) {
      if (record.s3.bucket.name !== bucket) continue;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      const [prefix, eventId, photoId, extra] = key.split("/");
      if (prefix !== "originals" || extra !== undefined || !isEventId(eventId ?? "") || !photoIdPattern.test(photoId ?? "")) continue;
      const photo = await repository.get({ eventId, photoId });
      if (photo?.uploadStatus !== "ISSUED") continue;
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const valid = object.ContentLength === photo.size && photo.size <= maxPhotoBytes && object.ContentType === photo.contentType;
      const bytes = valid && object.Body ? await object.Body.transformToByteArray() : undefined;
      if (!bytes && object.Body instanceof Readable) object.Body.destroy();
      const thumbnail = bytes?.length === photo.size ? await makeThumbnail(bytes, photoFormats[photo.contentType]) : undefined;
      if (!thumbnail) {
        await client.send(new PutObjectTaggingCommand({
          Bucket: bucket, Key: key, Tagging: { TagSet: [{ Key: "processing", Value: "failed" }] },
        }));
        await repository.finish(photo, "FAILED");
        continue;
      }
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: thumbnailKey(photo), Body: thumbnail, ContentType: "image/jpeg",
      }));
      await repository.finish(photo, "READY");
    }
  };
}

export const handler = createThumbnailHandler();
