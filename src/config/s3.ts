import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

export const s3Client = new S3Client({
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  ...(env.S3_ENDPOINT
    ? {
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: true, // Required for MinIO
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      }
    : {}),
});
