/**
 * Upload DOCX document templates to S3 and create DocumentTemplate records.
 * Run: npx tsx --env-file=.env scripts/seed-document-templates.ts
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { uploadFile } from "../src/lib/s3.js";
import { ensureBucket } from "../src/lib/s3.js";

const prisma = new PrismaClient();

interface TemplateConfig {
  categoryCode: string;
  categoryName: string;
  categoryDescription: string;
  folder: string;
  sortStartIndex: number;
}

const CATEGORIES: TemplateConfig[] = [
  {
    categoryCode: "CARTE_BRANSAMENT",
    categoryName: "Carte Branșament",
    categoryDescription: "Documente pentru dosarul de carte branșament gaze naturale",
    folder: "documente/Carte Bransament Templates",
    sortStartIndex: 1,
  },
  {
    categoryCode: "CARTE_CONDUCTA",
    categoryName: "Carte Conductă",
    categoryDescription: "Documente pentru dosarul de carte conductă gaze naturale",
    folder: "documente/Carte Conducta Distrigaz",
    sortStartIndex: 1,
  },
  {
    categoryCode: "DOSAR_ISCIR",
    categoryName: "Dosar ISCIR",
    categoryDescription: "Documente pentru dosarul ISCIR (procese verbale, decizii)",
    folder: "documente/Dosar ISCIR",
    sortStartIndex: 1,
  },
];

async function main() {
  await ensureBucket();

  for (const config of CATEGORIES) {
    // Create or update category
    await prisma.templateCategory.upsert({
      where: { code: config.categoryCode },
      update: {},
      create: {
        code: config.categoryCode,
        name: config.categoryName,
        description: config.categoryDescription,
        isActive: true,
        sortOrder: CATEGORIES.indexOf(config) + 10,
      },
    });
    console.log(`Category: ${config.categoryCode}`);

    // Read all DOCX files from folder
    const folderPath = join(process.cwd(), "..", config.folder);
    let files: string[];
    try {
      files = readdirSync(folderPath)
        .filter((f) => {
          const ext = extname(f).toLowerCase();
          return (ext === ".docx" || ext === ".doc") && !f.startsWith("~$");
        })
        .sort();
    } catch (err) {
      console.warn(`  Folder not found: ${folderPath}, skipping.`);
      continue;
    }

    let sortOrder = config.sortStartIndex;
    for (const file of files) {
      const filePath = join(folderPath, file);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;

      const name = basename(file, extname(file))
        .replace(/^\d+[\.\)]\s*/, "") // Remove leading number + dot/paren
        .replace(/\(x\d+\)/, "") // Remove (x1), (x2) suffixes
        .trim();

      // Check if template already exists
      const existing = await prisma.documentTemplate.findFirst({
        where: {
          tenantId: null,
          categoryCode: config.categoryCode,
          name: { contains: name.slice(0, 30), mode: "insensitive" },
        },
      });
      if (existing) {
        console.log(`  Skip (exists): ${name}`);
        sortOrder++;
        continue;
      }

      // Upload to S3
      const buffer = readFileSync(filePath);
      const ext = extname(file).toLowerCase();
      const s3Key = `templates/${config.categoryCode}/${Date.now()}-${file}`;
      const contentType = ext === ".docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/msword";

      await uploadFile(s3Key, buffer, contentType);

      // Create template record (global — no tenantId)
      await prisma.documentTemplate.create({
        data: {
          tenantId: null,
          categoryCode: config.categoryCode,
          name,
          description: file,
          s3Key,
          sortOrder: sortOrder++,
          isActive: true,
        },
      });
      console.log(`  Created: ${name} → ${s3Key}`);
    }
  }

  console.log("\nDone!");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
