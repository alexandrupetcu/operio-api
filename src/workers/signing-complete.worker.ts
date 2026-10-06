import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import crypto from "crypto";
import puppeteer from "puppeteer";
import { redisConnection } from "../config/redis.js";
import { getFileStream, uploadFile, ensureBucket } from "../lib/s3.js";
import { sendSigningComplete } from "../lib/email.js";
import { extractPdfMarkers } from "../lib/pdf-footer.js";

interface SigningCompleteJobData {
  signingSessionId: string;
  tenantId: string;
}

const prisma = new PrismaClient();

/** Strip diacritics so pdf-lib's WinAnsi encoding can handle Romanian text */
function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Convert HTML to PDF using Puppeteer (same as document-generation worker) */
async function htmlToPdf(html: string): Promise<Buffer> {
  // Reproduce the per-page header/footer embedded in the saved HTML markers.
  const { body, headerHtml, footerHtml } = extractPdfMarkers(html);
  html = body;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const styledHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            font-size: 12px;
            line-height: 1.6;
            margin: 0;
            padding: 40px;
            color: #333;
          }
          h1 { font-size: 18px; text-align: center; margin-bottom: 20px; }
          h2 { font-size: 14px; margin-top: 24px; margin-bottom: 8px; }
          hr { border: none; border-top: 1px solid #ccc; margin: 20px 0; }
          ul { padding-left: 20px; }
          li { margin-bottom: 4px; }
          p { margin: 6px 0; }
          span[data-type="variable"] {
            display: inline;
            background: none !important;
            padding: 0 !important;
            border-radius: 0 !important;
            font-size: inherit !important;
            color: inherit !important;
          }
          img {
            max-height: 80px;
            display: inline-block;
          }
          table {
            border-collapse: collapse;
            width: 100%;
            table-layout: fixed;
            border: none;
          }
          td, th {
            border: none;
            padding: 8px 12px;
            vertical-align: top;
          }
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;
    await page.setContent(styledHtml, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      ...(headerHtml || footerHtml
        ? {
            displayHeaderFooter: true,
            headerTemplate: headerHtml ?? "<div></div>",
            footerTemplate: footerHtml ?? "<div></div>",
            margin: {
              top: headerHtml ? "32mm" : "10mm",
              right: headerHtml ? "12mm" : "10mm",
              bottom: "18mm",
              left: headerHtml ? "12mm" : "10mm",
            },
          }
        : {
            margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
          }),
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * Inject signatory signatures into the saved HTML.
 * Replaces `data-signing-placeholder="client"` with actual signature images.
 * If multiple signatories, replaces sequentially (first placeholder → first signatory).
 */
function injectSignaturesIntoHtml(
  html: string,
  signatories: { name: string; signatureBase64: string; signedAt: Date | null; ipAddress: string | null }[]
): string {
  let result = html;

  for (const sig of signatories) {
    const sigHtml = [
      `<span style="display:inline-block;text-align:center">`,
      `<img src="${sig.signatureBase64}" style="height:80px;display:block" />`,
      `<span style="font-size:8px;color:#666">`,
      `Semnat electronic: ${sig.name}`,
      sig.signedAt ? ` | ${sig.signedAt.toLocaleDateString("ro-RO")} ${sig.signedAt.toLocaleTimeString("ro-RO")}` : "",
      `</span>`,
      `</span>`,
    ].join("");

    // Replace the first placeholder found
    result = result.replace(
      /<span[^>]*data-signing-placeholder="client"[^>]*>.*?<\/span>/s,
      sigHtml
    );
  }

  return result;
}

async function processJob(job: Job<SigningCompleteJobData>) {
  const { signingSessionId, tenantId } = job.data;

  const session = await prisma.signingSession.findUniqueOrThrow({
    where: { id: signingSessionId },
    include: {
      document: true,
      signatories: { orderBy: { signOrder: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      createdBy: { select: { email: true, firstName: true, lastName: true } },
    },
  });

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true },
  });

  if (!session.document.s3Key) {
    throw new Error("Document has no S3 file");
  }

  // Download original PDF and verify integrity
  const pdfStream = await getFileStream(session.document.s3Key);
  if (!pdfStream) throw new Error("Document file not found in S3");
  const pdfBuffer = await streamToBuffer(pdfStream);

  const currentHash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
  if (currentHash !== session.documentHash) {
    throw new Error("Document integrity check failed — hash mismatch");
  }

  // --- Build the signed document PDF ---
  let signedDocPdfBuffer: Buffer;

  // Try to load the saved HTML for re-rendering with signatures
  const htmlS3Key = session.document.s3Key.replace(/\.pdf$/, ".html");
  const htmlStream = await getFileStream(htmlS3Key).catch(() => null);

  if (htmlStream) {
    // HTML-based re-render: inject actual signatures and convert to PDF
    console.log("[signing-worker] Found saved HTML, re-rendering with signatures");
    const htmlBuffer = await streamToBuffer(htmlStream);
    let html = htmlBuffer.toString("utf-8");

    // Load signature images as base64
    const signatoryData: { name: string; signatureBase64: string; signedAt: Date | null; ipAddress: string | null }[] = [];
    for (const signatory of session.signatories) {
      if (signatory.signatureS3Key && signatory.status === "SIGNED") {
        const sigStream = await getFileStream(signatory.signatureS3Key);
        if (sigStream) {
          const sigBuffer = await streamToBuffer(sigStream);
          const base64 = `data:image/png;base64,${sigBuffer.toString("base64")}`;
          signatoryData.push({
            name: signatory.name,
            signatureBase64: base64,
            signedAt: signatory.signedAt,
            ipAddress: signatory.ipAddress,
          });
        }
      }
    }

    html = injectSignaturesIntoHtml(html, signatoryData);
    signedDocPdfBuffer = await htmlToPdf(html);
  } else {
    // Fallback: use original PDF + add signature page with pdf-lib
    console.log("[signing-worker] No saved HTML found, using pdf-lib fallback");
    signedDocPdfBuffer = await buildFallbackSignedPdf(pdfBuffer, session);
  }

  // --- Append Audit Trail page with pdf-lib ---
  const pdfDoc = await PDFDocument.load(signedDocPdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Re-fetch events to include SESSION_COMPLETED that we'll log shortly
  // (we log it after building the PDF, so use current events)
  const auditPage = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = auditPage.getSize();
  const margin = 50;
  let y = height - margin;

  auditPage.drawText("Audit Trail / Jurnal de Audit", {
    x: margin, y, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.1),
  });
  y -= 10;

  auditPage.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 20;

  // Document info
  auditPage.drawText(stripDiacritics(`Document: ${session.document.name}`), {
    x: margin, y, size: 9, font, color: rgb(0.3, 0.3, 0.3),
  });
  y -= 14;
  auditPage.drawText(stripDiacritics(`Finalizat: ${new Date().toLocaleDateString("ro-RO")} ${new Date().toLocaleTimeString("ro-RO")}`), {
    x: margin, y, size: 9, font, color: rgb(0.3, 0.3, 0.3),
  });
  y -= 20;

  // Signatories summary
  auditPage.drawText("Semnatari / Signatories", {
    x: margin, y, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 14;

  for (const signatory of session.signatories) {
    const status = signatory.status === "SIGNED"
      ? `Semnat ${signatory.signedAt?.toISOString() || ""} | IP: ${signatory.ipAddress || "N/A"}`
      : signatory.status;
    auditPage.drawText(stripDiacritics(`${signatory.name} (${signatory.role}) — ${status}`), {
      x: margin + 10, y, size: 8, font, color: rgb(0.3, 0.3, 0.3),
    });
    y -= 12;
  }
  y -= 10;

  // Events table
  auditPage.drawText("Evenimente / Events", {
    x: margin, y, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 14;

  const cols = [margin, margin + 140, margin + 290, margin + 390];
  const headerTexts = ["Timestamp (UTC)", "Event", "Signatory", "IP Address"];
  for (let i = 0; i < headerTexts.length; i++) {
    auditPage.drawText(headerTexts[i], {
      x: cols[i], y, size: 8, font: fontBold, color: rgb(0.2, 0.2, 0.2),
    });
  }
  y -= 12;

  for (const event of session.events) {
    if (y < margin + 40) break;

    const sigName = event.signatoryId
      ? session.signatories.find((s) => s.id === event.signatoryId)?.name || "—"
      : "System";

    auditPage.drawText(event.createdAt.toISOString().slice(0, 19) + "Z", {
      x: cols[0], y, size: 7, font, color: rgb(0.3, 0.3, 0.3),
    });
    auditPage.drawText(event.eventType, {
      x: cols[1], y, size: 7, font, color: rgb(0.3, 0.3, 0.3),
    });
    auditPage.drawText(stripDiacritics(sigName), {
      x: cols[2], y, size: 7, font, color: rgb(0.3, 0.3, 0.3),
    });
    auditPage.drawText(event.ipAddress || "—", {
      x: cols[3], y, size: 7, font, color: rgb(0.3, 0.3, 0.3),
    });
    y -= 11;
  }

  // Footer
  y = margin + 20;
  auditPage.drawText(`Original document SHA-256: ${session.documentHash}`, {
    x: margin, y, size: 7, font, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 12;
  auditPage.drawText(
    "This audit trail is generated automatically and cannot be modified.",
    { x: margin, y, size: 7, font, color: rgb(0.4, 0.4, 0.4) }
  );
  y -= 12;
  auditPage.drawText(
    stripDiacritics("Document semnat electronic / Electronically signed document"),
    { x: margin, y, size: 7, font, color: rgb(0.4, 0.4, 0.4) }
  );

  // --- Save final signed PDF ---
  const signedPdfBytes = await pdfDoc.save();
  const signedBuffer = Buffer.from(signedPdfBytes);
  const signedS3Key = `${tenantId}/documents/${session.documentId}/signed.pdf`;
  await uploadFile(signedS3Key, signedBuffer, "application/pdf");

  const signedHash = crypto.createHash("sha256").update(signedBuffer).digest("hex");

  // Update document
  await prisma.document.update({
    where: { id: session.documentId },
    data: { status: "SIGNED", s3Key: signedS3Key },
  });

  // Update session
  await prisma.signingSession.update({
    where: { id: signingSessionId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      signedDocumentS3Key: signedS3Key,
    },
  });

  // Log completion event
  await prisma.signingEvent.create({
    data: {
      signingSessionId,
      eventType: "SESSION_COMPLETED",
      documentHash: signedHash,
      metadata: { signedDocumentS3Key: signedS3Key },
    },
  });

  // Send completion emails with signed PDF attached
  for (const signatory of session.signatories) {
    await sendSigningComplete({
      to: signatory.email,
      signatoryName: signatory.name,
      documentName: session.document.name,
      tenantName: tenant.name,
      pdfBuffer: signedBuffer,
    }).catch((err) => console.error(`[signing-worker] Email to ${signatory.email} failed:`, err));
  }

  if (session.createdBy.email) {
    await sendSigningComplete({
      to: session.createdBy.email,
      signatoryName: `${session.createdBy.firstName} ${session.createdBy.lastName}`,
      documentName: session.document.name,
      tenantName: tenant.name,
      pdfBuffer: signedBuffer,
    }).catch((err) => console.error(`[signing-worker] Email to creator failed:`, err));
  }

  return { success: true, signedS3Key };
}

/** Fallback for documents without saved HTML — adds a signature page with pdf-lib */
async function buildFallbackSignedPdf(
  pdfBuffer: Buffer,
  session: Awaited<ReturnType<typeof prisma.signingSession.findUniqueOrThrow>>
    & { signatories: any[]; events: any[]; document: { name: string } }
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const sigPage = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = sigPage.getSize();
  const margin = 50;
  let y = height - margin;

  sigPage.drawText(stripDiacritics("Pagina de Semnaturi / Signature Page"), {
    x: margin, y, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.1),
  });
  y -= 10;

  sigPage.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 30;

  sigPage.drawText(stripDiacritics(`Document: ${session.document.name}`), {
    x: margin, y, size: 10, font, color: rgb(0.3, 0.3, 0.3),
  });
  y -= 16;
  sigPage.drawText(stripDiacritics(`Data completarii: ${new Date().toLocaleDateString("ro-RO")} ${new Date().toLocaleTimeString("ro-RO")}`), {
    x: margin, y, size: 10, font, color: rgb(0.3, 0.3, 0.3),
  });
  y -= 30;

  for (const signatory of session.signatories) {
    if (y < 200) {
      const newPage = pdfDoc.addPage([595.28, 841.89]);
      y = newPage.getSize().height - margin;
    }

    sigPage.drawText(stripDiacritics(signatory.name), {
      x: margin, y, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1),
    });
    y -= 16;
    sigPage.drawText(stripDiacritics(`Rol: ${signatory.role}`), {
      x: margin, y, size: 10, font, color: rgb(0.3, 0.3, 0.3),
    });
    y -= 14;

    if (signatory.signatureS3Key) {
      try {
        const sigStream = await getFileStream(signatory.signatureS3Key);
        if (sigStream) {
          const sigBuffer = await streamToBuffer(sigStream);
          const sigImage = await pdfDoc.embedPng(sigBuffer);
          const sigDims = sigImage.scale(0.5);
          const imgWidth = Math.min(sigDims.width, 200);
          const imgHeight = (imgWidth / sigDims.width) * sigDims.height;
          sigPage.drawImage(sigImage, {
            x: margin,
            y: y - imgHeight,
            width: imgWidth,
            height: imgHeight,
          });
          y -= imgHeight + 8;
        }
      } catch (err) {
        console.error(`[signing-worker] Failed to embed signature for ${signatory.name}:`, err);
      }
    }

    if (signatory.signedAt) {
      sigPage.drawText(
        `Semnat: ${signatory.signedAt.toISOString()} | IP: ${signatory.ipAddress || "N/A"}`,
        { x: margin, y, size: 8, font, color: rgb(0.5, 0.5, 0.5) }
      );
      y -= 14;
    }

    y -= 20;
  }

  sigPage.drawText(stripDiacritics("Document semnat electronic / Electronically signed document"), {
    x: margin, y: margin, size: 8, font, color: rgb(0.5, 0.5, 0.5),
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// Start worker
async function main() {
  await ensureBucket();

  const worker = new Worker("signing-complete", processJob, {
    connection: redisConnection,
    concurrency: 2,
  });

  worker.on("completed", (job) => {
    console.log(`[signing-worker] Job ${job.id} completed for session ${job.data.signingSessionId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[signing-worker] Job ${job?.id} failed for session ${job?.data.signingSessionId}:`,
      err.message
    );
  });

  console.log("Signing complete worker started");

  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
