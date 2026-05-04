import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redisConnection } from "../config/redis.js";
import { getFileStream } from "../lib/s3.js";
import { parseRevisionText } from "../modules/equipment-revisions/revision-pdf-parser.js";

interface RevisionJobData {
  revisionId: string;
  s3Key: string;
  tenantId: string;
}

const prisma = new PrismaClient();

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function pdfToText(pdfPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pdftotext", ["-layout", pdfPath, "-"]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`pdftotext exit ${code}: ${stderr}`));
    });
    proc.on("error", reject);
    setTimeout(() => { proc.kill(); reject(new Error("pdftotext timeout")); }, 30000);
  });
}

async function processJob(job: Job<RevisionJobData>) {
  const { revisionId, s3Key } = job.data;
  console.log(`[${revisionId}] Starting job`);

  await prisma.equipmentRevision.update({
    where: { id: revisionId },
    data: { status: "PROCESSING" },
  });

  try {
    // Download PDF from S3
    const stream = await getFileStream(s3Key);
    if (!stream) throw new Error("PDF file not found in S3");
    const buffer = await streamToBuffer(stream);
    console.log(`[${revisionId}] Downloaded ${buffer.length} bytes`);

    // Extract text from PDF
    const tmpPath = join(tmpdir(), `revision-${randomUUID()}.pdf`);
    await writeFile(tmpPath, buffer);
    const rawText = await pdfToText(tmpPath);
    await unlink(tmpPath).catch(() => {});
    console.log(`[${revisionId}] Extracted ${rawText.length} chars`);

    // Parse extracted text
    const parsed = parseRevisionText(rawText);
    console.log(`[${revisionId}] Parsed: operator=${parsed.operator.name}`);

    // Update revision with parsed data
    const revision = await prisma.equipmentRevision.update({
      where: { id: revisionId },
      data: {
        status: "COMPLETED",
        ...(parsed.revisionDate && { revisionDate: parsed.revisionDate }),
        operatorName: parsed.operator.name,
        operatorAddress: parsed.operator.address,
        operatorPhone: parsed.operator.phone,
        operatorEmail: parsed.operator.email,
        analyzerName: parsed.analyzer.name,
        analyzerSerial: parsed.analyzer.serial,
        location: parsed.location,
        pdfEquipmentName: parsed.equipmentName,
        pdfEquipmentSerial: parsed.equipmentSerial,
        pdfClientAddress: parsed.clientAddress,
        analysisData: parsed.analysisData as any,
        rawText: parsed.rawText,
      },
    });

    // Update equipment name/serial from PDF if available
    if (parsed.equipmentName || parsed.equipmentSerial) {
      const equipment = await prisma.equipment.findUnique({
        where: { id: revision.equipmentId },
        select: { name: true, serial: true },
      });
      if (equipment) {
        const updates: Record<string, string> = {};
        if (parsed.equipmentName) updates.name = parsed.equipmentName;
        if (parsed.equipmentSerial) updates.serial = parsed.equipmentSerial;
        if (Object.keys(updates).length > 0) {
          await prisma.equipment.update({
            where: { id: revision.equipmentId },
            data: updates,
          });
          console.log(`[${revisionId}] Updated equipment: ${JSON.stringify(updates)}`);
        }
      }
    }
    console.log(`[${revisionId}] COMPLETED`);

    return { success: true, revisionId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[${revisionId}] Error:`, errorMessage);

    try {
      await prisma.equipmentRevision.update({
        where: { id: revisionId },
        data: { status: "FAILED" },
      });
    } catch {
      // revision may have been deleted
    }

    throw error;
  }
}

// Start worker
async function main() {
  const worker = new Worker("revision-processing", processJob, {
    connection: redisConnection,
    concurrency: 2,
  });

  worker.on("completed", (job) => {
    console.log(`Revision parsing completed: ${job.data.revisionId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Revision parsing failed for ${job?.data.revisionId}:`, err.message);
  });

  console.log("Revision processing worker started");

  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
