import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { getFileStream, uploadFile } from "../lib/s3.js";
import { renderDocx } from "../lib/docx-engine.js";
import { ensureBucket } from "../lib/s3.js";

interface DocumentJobData {
  documentId: string;
  tenantId: string;
  projectId: string;
  templateId: string;
}

const prisma = new PrismaClient();

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function processJob(job: Job<DocumentJobData>) {
  const { documentId, tenantId, projectId, templateId } = job.data;

  // Update status to GENERATING
  await prisma.document.update({
    where: { id: documentId },
    data: { status: "GENERATING" },
  });

  try {
    // Fetch template from S3
    const template = await prisma.documentTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });

    if (!template.s3Key) throw new Error("Template has no S3 file");
    const templateStream = await getFileStream(template.s3Key);
    if (!templateStream) throw new Error("Template file not found in S3");
    const templateBuffer = await streamToBuffer(templateStream);

    // Fetch project + client data
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { client: true },
    });

    // Build template data from project and client
    const data: Record<string, unknown> = {
      // Client fields
      client_name: project.client.type === "COMPANY"
        ? project.client.companyName || ""
        : `${project.client.firstName || ""} ${project.client.lastName || ""}`.trim(),
      client_company_name: project.client.companyName || "",
      client_first_name: project.client.firstName || "",
      client_last_name: project.client.lastName || "",
      client_cui: project.client.cui || "",
      client_type: project.client.type,
      client_address: project.client.address,
      client_city: project.client.city,
      client_county: project.client.county,
      client_phone: project.client.phone || "",
      client_email: project.client.email || "",
      // Project fields
      project_name: project.name,
      project_type: project.type,
      project_address: project.address,
      project_city: project.city,
      project_county: project.county,
      project_status: project.status,
      // Date
      date: new Date().toLocaleDateString("ro-RO"),
      year: new Date().getFullYear().toString(),
      // Spread metadata fields
      ...(project.metadata as Record<string, unknown> || {}),
    };

    // Render document
    const outputBuffer = renderDocx(templateBuffer, data);

    // Upload to S3
    const s3Key = `${tenantId}/projects/${projectId}/documents/${documentId}.docx`;
    await uploadFile(
      s3Key,
      outputBuffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    // Update document status
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "COMPLETED", s3Key },
    });

    return { success: true, documentId };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED", errorMessage },
    });

    throw error;
  }
}

// Start worker
async function main() {
  await ensureBucket();

  const worker = new Worker("document-generation", processJob, {
    connection: redisConnection,
    concurrency: 3,
  });

  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed for document ${job.data.documentId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `Job ${job?.id} failed for document ${job?.data.documentId}:`,
      err.message
    );
  });

  console.log("Document generation worker started");

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
