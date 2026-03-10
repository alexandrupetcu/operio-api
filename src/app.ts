import { buildServer } from "./server.js";
import { env } from "./config/env.js";
import { ensureBucket } from "./lib/s3.js";

async function main() {
  const server = await buildServer();

  try {
    await server.listen({ port: env.PORT, host: env.HOST });
    // Non-blocking: try to create S3 bucket after server starts
    ensureBucket().catch((err) =>
      server.log.warn(err, "Failed to ensure S3 bucket (MinIO may not be ready)")
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
