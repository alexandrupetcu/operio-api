import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "../config/s3.js";
import { safeS3Filename } from "./safe-filename.js";
import { env } from "../config/env.js";

export async function ensureBucket() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    console.log(`Created S3 bucket: ${env.S3_BUCKET}`);
  }
  await ensureBucketVersioning();
}

/**
 * Enable bucket versioning so an overwrite or delete keeps the prior version
 * (recoverable) instead of destroying it — templates are replaced in place
 * (in-app editor, re-seeds), and a non-versioned bucket loses the old file.
 * Idempotent; best-effort (some S3-compatible stores don't support it).
 */
export async function ensureBucketVersioning() {
  try {
    const current = await s3Client.send(new GetBucketVersioningCommand({ Bucket: env.S3_BUCKET }));
    if (current.Status === "Enabled") return;
    await s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: env.S3_BUCKET,
        VersioningConfiguration: { Status: "Enabled" },
      })
    );
    console.log(`Enabled versioning on S3 bucket: ${env.S3_BUCKET}`);
  } catch (err) {
    console.warn(`Could not enable bucket versioning (${(err as Error).message}) — overwrites won't be recoverable.`);
  }
}

export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return key;
}

export async function getFileStream(key: string) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
    })
  );
  return response.Body;
}

/** Download an object into a Buffer. */
export async function getFileBuffer(key: string): Promise<Buffer> {
  const body = await getFileStream(key);
  if (!body) throw new Error(`File not found in S3: ${key}`);
  const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

export async function getPresignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string
): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ...(downloadFilename
        ? { ResponseContentDisposition: `attachment; filename="${downloadFilename.replace(/[^\w.\- ]+/g, "_")}"` }
        : {}),
    }),
    { expiresIn }
  );
}

export async function deleteFile(key: string) {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
    })
  );
}

/**
 * Ensure a tenant "folder" exists in the bucket.
 * S3/MinIO folders are key prefixes — we create a zero-byte placeholder
 * the first time so the tenant directory is visible in the console.
 */
export async function ensureTenantFolder(tenantId: string): Promise<void> {
  const result = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: env.S3_BUCKET,
      Prefix: `${tenantId}/`,
      MaxKeys: 1,
    })
  );

  const exists = (result.Contents?.length ?? 0) > 0 || (result.CommonPrefixes?.length ?? 0) > 0;
  if (!exists) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: `${tenantId}/.keep`,
        Body: Buffer.alloc(0),
        ContentType: "application/octet-stream",
      })
    );
  }
}

/**
 * Build the S3 key for a step file upload.
 * Structure: {tenantId}/{projectId}/{stepInstanceId}/{safeName}
 *
 * The supplied `filename` is sanitized via `safeS3Filename` — the user-visible
 * original name should be kept in DB metadata, not in the S3 path.
 */
export function buildStepFileKey(
  tenantId: string,
  projectId: string,
  stepInstanceId: string,
  filename: string
): string {
  return `${tenantId}/${projectId}/${stepInstanceId}/${safeS3Filename(filename)}`;
}
