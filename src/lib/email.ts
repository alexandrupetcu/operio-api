import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    console.log(`[email] Creating SMTP transporter: ${env.SMTP_HOST}:${env.SMTP_PORT} user=${env.SMTP_USER}`);
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
  }
  return transporter;
}

export async function verifySmtp(): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured");
    return false;
  }
  try {
    await t.verify();
    console.log("[email] SMTP connection verified successfully");
    return true;
  } catch (err) {
    console.error("[email] SMTP verification failed:", err);
    return false;
  }
}

export function isEmailConfigured(): boolean {
  return !!env.SMTP_HOST;
}

/**
 * Generic notification email (activity reminders / dashboard alerts).
 * Reuses the shared SMTP transporter. No-op when SMTP is unconfigured.
 */
export async function sendNotificationEmail(opts: {
  to: string;
  subject: string;
  body: string;
  url?: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping notification to", opts.to);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">${opts.subject}</h2>
      <p style="color:#333;white-space:pre-line">${opts.body}</p>
      ${
        opts.url
          ? `<p style="margin-top:20px">
               <a href="${opts.url}"
                  style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
                 Deschide în Operio
               </a>
             </p>`
          : ""
      }
      <p style="color:#888;font-size:12px;margin-top:24px">
        Acest email a fost trimis automat de Operio. Poți dezactiva notificările pe email din Setări.
      </p>
    </div>
  `;

  const info = await t.sendMail({
    from: env.SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    html,
  });
  console.log(`[email] Notification sent to ${opts.to} — messageId: ${info.messageId}`);
}

export async function sendSigningInvitation(opts: {
  to: string;
  signatoryName: string;
  documentName: string;
  signingUrl: string;
  message?: string | null;
  tenantName: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping signing invitation to", opts.to);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Invitație de semnare document</h2>
      <p>Bună ziua, <strong>${opts.signatoryName}</strong>,</p>
      <p>Compania <strong>${opts.tenantName}</strong> vă invită să semnați documentul:</p>
      <p style="background:#f5f5f5;padding:12px;border-radius:6px;font-weight:600">${opts.documentName}</p>
      ${opts.message ? `<p style="color:#555"><em>${opts.message}</em></p>` : ""}
      <p>
        <a href="${opts.signingUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Semnează documentul
        </a>
      </p>
      <p style="color:#888;font-size:12px;margin-top:24px">
        Dacă nu puteți accesa butonul, copiați acest link în browser:<br>
        <a href="${opts.signingUrl}">${opts.signingUrl}</a>
      </p>
    </div>
  `;

  try {
    const info = await t.sendMail({
      from: env.SMTP_FROM,
      to: opts.to,
      subject: `Semnare document: ${opts.documentName}`,
      html,
    });
    console.log(`[email] Invitation sent to ${opts.to} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send invitation to ${opts.to}:`, err);
    throw err;
  }
}

export async function sendSigningComplete(opts: {
  to: string;
  signatoryName: string;
  documentName: string;
  tenantName: string;
  pdfBuffer?: Buffer;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping completion email to", opts.to);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Document semnat cu succes</h2>
      <p>Bună ziua, <strong>${opts.signatoryName}</strong>,</p>
      <p>Documentul <strong>${opts.documentName}</strong> a fost semnat de toate părțile.</p>
      ${opts.pdfBuffer ? `<p>Găsiți documentul semnat atașat acestui email.</p>` : ""}
      <p style="color:#888;font-size:12px;margin-top:24px">
        Acest email a fost trimis automat de ${opts.tenantName}.
      </p>
    </div>
  `;

  try {
    const info = await t.sendMail({
      from: env.SMTP_FROM,
      to: opts.to,
      subject: `Document semnat: ${opts.documentName}`,
      html,
      attachments: opts.pdfBuffer
        ? [{ filename: `${opts.documentName} - semnat.pdf`, content: opts.pdfBuffer, contentType: "application/pdf" }]
        : undefined,
    });
    console.log(`[email] Completion email sent to ${opts.to} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send completion email to ${opts.to}:`, err);
    throw err;
  }
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  firstName: string;
  resetUrl: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping password reset to", opts.to);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Resetare parolă Operio</h2>
      <p>Bună, <strong>${opts.firstName}</strong>,</p>
      <p>Ai cerut resetarea parolei pentru contul tău Operio. Apasă butonul de mai jos pentru a alege o parolă nouă:</p>
      <p>
        <a href="${opts.resetUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Resetează parola
        </a>
      </p>
      <p style="color:#555">Link-ul expiră în <strong>1 oră</strong> și poate fi folosit o singură dată.</p>
      <p style="color:#888;font-size:12px;margin-top:24px">
        Dacă nu ai cerut tu această resetare, ignoră acest email — contul tău rămâne neschimbat.<br>
        Link direct: <a href="${opts.resetUrl}">${opts.resetUrl}</a>
      </p>
    </div>
  `;

  try {
    const info = await t.sendMail({
      from: env.SMTP_FROM,
      to: opts.to,
      subject: "Resetare parolă Operio",
      html,
    });
    console.log(`[email] Reset link sent to ${opts.to} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send reset email to ${opts.to}:`, err);
    throw err;
  }
}
