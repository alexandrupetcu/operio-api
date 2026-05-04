import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "../config/s3.js";
import { env } from "../config/env.js";

export async function ensureBucket() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    console.log(`Created S3 bucket: ${env.S3_BUCKET}`);
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

export async function getPresignedUrl(
  key: string,
  expiresIn = 3600
): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
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
 * Structure: {tenantId}/{projectId}/{stepInstanceId}/{filename}
 */
export function buildStepFileKey(
  tenantId: string,
  projectId: string,
  stepInstanceId: string,
  filename: string
): string {
  return `${tenantId}/${projectId}/${stepInstanceId}/${filename}`;
}
