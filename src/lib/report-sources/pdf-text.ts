import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Text cu layout din PDF (pdftotext -layout). Parserii pe regex se bazează pe
 * coloanele păstrate de `-layout`, deci toate sursele primesc același text.
 */
export function extractPdfText(buffer: Buffer): Promise<string> {
  const tmpPath = join(tmpdir(), `report-${randomUUID()}.pdf`);
  return new Promise<string>((resolve, reject) => {
    writeFile(tmpPath, buffer)
      .then(() => {
        execFile(
          "pdftotext",
          ["-layout", tmpPath, "-"],
          { timeout: 30000, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
          (err, stdout) => {
            unlink(tmpPath).catch(() => {});
            if (err) reject(new Error(`pdftotext failed: ${err.message}`));
            else resolve(stdout);
          },
        );
      })
      .catch((err) => {
        unlink(tmpPath).catch(() => {});
        reject(err);
      });
  });
}
