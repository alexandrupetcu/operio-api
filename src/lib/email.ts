import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env.js";

let transporter: Transporter | null = null;

/** Orice valoare venită din date (nume, mesaje, titluri) intră în HTML doar escapată. */
const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** În jurnale doar domeniul destinatarului — adresa completă e dată personală. */
const mailDomain = (to: string) => {
  const at = to.lastIndexOf("@");
  return at >= 0 ? `@${to.slice(at + 1)}` : "<no-domain>";
};

/** Default Reply-To for automated mail: replies to noreply@ land in the firm's real inbox. */
const replyTo = () => (env.SMTP_REPLY_TO ? { replyTo: env.SMTP_REPLY_TO } : {});

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    console.log(`[email] Creating SMTP transporter: ${env.SMTP_HOST}:${env.SMTP_PORT}`);
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
    console.warn("[email] SMTP not configured — skipping notification to", mailDomain(opts.to));
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">${escapeHtml(opts.subject)}</h2>
      <p style="color:#333;white-space:pre-line">${escapeHtml(opts.body)}</p>
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
    ...replyTo(),
    to: opts.to,
    subject: opts.subject,
    html,
  });
  console.log(`[email] Notification sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
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
    console.warn("[email] SMTP not configured — skipping signing invitation to", mailDomain(opts.to));
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Invitație de semnare document</h2>
      <p>Bună ziua, <strong>${escapeHtml(opts.signatoryName)}</strong>,</p>
      <p>Compania <strong>${escapeHtml(opts.tenantName)}</strong> vă invită să semnați documentul:</p>
      <p style="background:#f5f5f5;padding:12px;border-radius:6px;font-weight:600">${escapeHtml(opts.documentName)}</p>
      ${opts.message ? `<p style="color:#555"><em>${escapeHtml(opts.message)}</em></p>` : ""}
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
      ...replyTo(),
      to: opts.to,
      subject: `Semnare document: ${opts.documentName}`,
      html,
    });
    console.log(`[email] Invitation sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send invitation to ${mailDomain(opts.to)}:`, err);
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
    console.warn("[email] SMTP not configured — skipping completion email to", mailDomain(opts.to));
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Document semnat cu succes</h2>
      <p>Bună ziua, <strong>${escapeHtml(opts.signatoryName)}</strong>,</p>
      <p>Documentul <strong>${escapeHtml(opts.documentName)}</strong> a fost semnat de toate părțile.</p>
      ${opts.pdfBuffer ? `<p>Găsiți documentul semnat atașat acestui email.</p>` : ""}
      <p style="color:#888;font-size:12px;margin-top:24px">
        Acest email a fost trimis automat de ${escapeHtml(opts.tenantName)}.
      </p>
    </div>
  `;

  try {
    const info = await t.sendMail({
      from: env.SMTP_FROM,
      ...replyTo(),
      to: opts.to,
      subject: `Document semnat: ${opts.documentName}`,
      html,
      attachments: opts.pdfBuffer
        ? [{ filename: `${opts.documentName} - semnat.pdf`, content: opts.pdfBuffer, contentType: "application/pdf" }]
        : undefined,
    });
    console.log(`[email] Completion email sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send completion email to ${mailDomain(opts.to)}:`, err);
    throw err;
  }
}

/**
 * Exemplarul clientului din Fișa de evidență, completat cu numărul de înregistrare
 * de la operatorul de sistem — obligația OE de la art. 9 alin. (7) din Ord. ANRE 179/2015
 * (în max. 2 zile lucrătoare de la înregistrare, inclusiv prin e-mail).
 */
export async function sendFisaRegisteredEmail(opts: {
  to: string;
  clientName: string;
  tenantName: string;
  /** „revizie tehnică” / „verificare tehnică” */
  workLabel: string;
  distributorName: string | null;
  registrationNumber: string;
  registeredAt: Date;
  address: string | null;
  pdf?: { filename: string; buffer: Buffer } | null;
  /** Restul documentelor vizitei (PV, buletin, contract) — clientul le primește abia acum. */
  extraPdfs?: { filename: string; buffer: Buffer }[];
  /** `iscir` = raportul reviziei de centrală (nu fișa ANRE a instalației). */
  document?: "fisa" | "iscir";
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping OS-registration email to", mailDomain(opts.to));
    return;
  }
  const os = opts.distributorName || "operatorul de distribuție";
  const dateRo = opts.registeredAt.toLocaleDateString("ro-RO");
  const iscir = opts.document === "iscir";
  const at = opts.address ? ` de la adresa <strong>${escapeHtml(opts.address)}</strong>` : "";
  const reg = `a fost înregistrat${iscir ? "" : "ă"} la <strong>${escapeHtml(os)}</strong> cu numărul <strong>${escapeHtml(opts.registrationNumber)}</strong> din ${dateRo}`;
  const heading = iscir ? "Raportul de revizie a centralei a fost înregistrat" : `Fișa de ${escapeHtml(opts.workLabel)} a fost înregistrată`;
  const body = iscir
    ? `<p>Raportul de verificări, încercări și probe întocmit la revizia centralei termice${at} ${reg}.</p>`
    : `<p>Fișa de evidență a lucrărilor de ${escapeHtml(opts.workLabel)} a instalației de utilizare a gazelor naturale${at} ${reg}.</p>`;
  const footer = iscir
    ? `Acest email a fost trimis automat de ${escapeHtml(opts.tenantName)}.`
    : `Acest email a fost trimis automat de ${escapeHtml(opts.tenantName)}, conform art. 9 alin. (7) din Procedura aprobată prin Ordinul ANRE nr. 179/2015.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">${heading}</h2>
      <p>Bună ziua, <strong>${escapeHtml(opts.clientName)}</strong>,</p>
      ${body}
      ${opts.pdf ? `<p>Găsiți atașat exemplarul dumneavoastră${opts.extraPdfs?.length ? ", împreună cu celelalte documente ale vizitei" : ""}. Vă recomandăm să le păstrați împreună cu documentele ${iscir ? "centralei" : "instalației"}.</p>` : ""}
      <p style="color:#888;font-size:12px;margin-top:24px">${footer}</p>
    </div>
  `;
  const info = await t.sendMail({
    from: env.SMTP_FROM,
    ...replyTo(),
    to: opts.to,
    subject: iscir
      ? `Raportul de revizie a centralei — înregistrat la ${os} nr. ${opts.registrationNumber}`
      : `Fișa de ${opts.workLabel} — înregistrată la ${os} nr. ${opts.registrationNumber}`,
    html,
    attachments: opts.pdf
      ? [opts.pdf, ...(opts.extraPdfs ?? [])].map((a) => ({ filename: a.filename, content: a.buffer, contentType: "application/pdf" }))
      : undefined,
  });
  console.log(`[email] OS-registration email sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
}

/** Invitația unui utilizator nou: link de setare a parolei (valabil 7 zile). */
export async function sendUserInviteEmail(opts: {
  to: string;
  firstName: string;
  tenantName: string;
  invitedBy: string;
  setPasswordUrl: string;
  mobileAccess: boolean;
}): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping user invite to", mailDomain(opts.to));
    return false;
  }
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Bun venit în Operio</h2>
      <p>Bună, <strong>${escapeHtml(opts.firstName)}</strong>,</p>
      <p><strong>${escapeHtml(opts.invitedBy)}</strong> ți-a creat un cont în Operio pentru <strong>${escapeHtml(opts.tenantName)}</strong>.</p>
      <p>Setează-ți parola ca să intri în cont:</p>
      <p>
        <a href="${opts.setPasswordUrl}"
           style="display:inline-block;background:#1a1a1a;color:#F5D000;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700">
          Setează parola
        </a>
      </p>
      ${opts.mobileAccess ? `<p>Ai acces și la aplicația mobilă Operio — după ce îți setezi parola, instaleaz-o de pe telefon și intră cu aceleași date.</p>` : ""}
      <p style="color:#888;font-size:12px;margin-top:24px">
        Linkul e valabil 7 zile. Dacă nu te așteptai la acest e-mail, îl poți ignora.<br>
        Dacă butonul nu merge, copiază linkul: <a href="${opts.setPasswordUrl}">${opts.setPasswordUrl}</a>
      </p>
    </div>
  `;
  const info = await t.sendMail({
    from: env.SMTP_FROM,
    ...replyTo(),
    to: opts.to,
    subject: `${opts.tenantName} te-a invitat în Operio`,
    html,
  });
  console.log(`[email] User invite sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
  return true;
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  firstName: string;
  resetUrl: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping password reset to", mailDomain(opts.to));
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
      ...replyTo(),
      to: opts.to,
      subject: "Resetare parolă Operio",
      html,
    });
    console.log(`[email] Reset link sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send reset email to ${mailDomain(opts.to)}:`, err);
    throw err;
  }
}

/**
 * Linkul de confirmare a adresei de e-mail pentru un cont nou (înregistrare publică).
 * Până la confirmare contul merge, dar nu poate invita colegi și nu primește notificări pe e-mail.
 */
export async function sendEmailVerificationEmail(opts: {
  to: string;
  firstName: string;
  verifyUrl: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping e-mail verification to", mailDomain(opts.to));
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Confirmă adresa de e-mail</h2>
      <p>Bună, <strong>${escapeHtml(opts.firstName)}</strong>,</p>
      <p>Mulțumim că ți-ai creat cont în Operio. Apasă butonul de mai jos ca să confirmi că această adresă îți aparține:</p>
      <p>
        <a href="${opts.verifyUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
          Confirmă adresa
        </a>
      </p>
      <p style="color:#555">Link-ul expiră în <strong>48 de ore</strong> și poate fi folosit o singură dată. Dacă expiră, poți cere unul nou din aplicație.</p>
      <p style="color:#888;font-size:12px;margin-top:24px">
        Dacă nu ți-ai creat tu un cont Operio, ignoră acest e-mail.<br>
        Link direct: <a href="${opts.verifyUrl}">${opts.verifyUrl}</a>
      </p>
    </div>
  `;

  try {
    const info = await t.sendMail({
      from: env.SMTP_FROM,
      ...replyTo(),
      to: opts.to,
      subject: "Confirmă adresa de e-mail — Operio",
      html,
    });
    console.log(`[email] Verification link sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
  } catch (err) {
    console.error(`[email] Failed to send verification email to ${mailDomain(opts.to)}:`, err);
    throw err;
  }
}

/**
 * Codul de 6 cifre pentru autentificarea în doi pași (login, activare sau gestionare).
 * Fără SMTP, în dezvoltare codul apare în consolă (altfel n-ar exista cum să-l folosești
 * local); în producție nu se loghează niciodată.
 */
export async function sendTwoFactorCodeEmail(opts: {
  to: string;
  firstName: string;
  code: string;
  purpose: "login" | "enable" | "manage";
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    if (env.NODE_ENV === "development") {
      console.warn(`[email] SMTP not configured — 2FA code for ${mailDomain(opts.to)}: ${opts.code}`);
    } else {
      console.warn("[email] SMTP not configured — skipping 2FA code to", mailDomain(opts.to));
    }
    return;
  }
  const intro = {
    login: "Folosește codul de mai jos ca să termini autentificarea în Operio:",
    enable: "Folosește codul de mai jos ca să confirmi activarea autentificării în doi pași:",
    manage: "Folosește codul de mai jos ca să confirmi schimbarea setărilor de securitate:",
  }[opts.purpose];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">Codul tău de autentificare</h2>
      <p>Bună, <strong>${escapeHtml(opts.firstName)}</strong>,</p>
      <p>${intro}</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace;margin:20px 0">${escapeHtml(opts.code)}</p>
      <p style="color:#555">Codul e valabil <strong>10 minute</strong>. Nu-l spune nimănui — echipa Operio nu ți-l va cere niciodată.</p>
      <p style="color:#888;font-size:12px;margin-top:24px">
        Dacă nu ai încercat tu să te autentifici, cineva îți cunoaște parola: schimb-o din Setări → Contul meu → Securitate.
      </p>
    </div>
  `;
  const info = await t.sendMail({
    from: env.SMTP_FROM,
    ...replyTo(),
    to: opts.to,
    subject: `${opts.code} — codul tău de autentificare Operio`,
    html,
  });
  console.log(`[email] 2FA code sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
}

/** Anunț de securitate: autentificarea în doi pași a fost activată / dezactivată / resetată. */
export async function sendTwoFactorChangedEmail(opts: {
  to: string;
  firstName: string;
  event: "enabled" | "disabled" | "reset";
  method?: "email" | "totp";
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[email] SMTP not configured — skipping 2FA notice to", mailDomain(opts.to));
    return;
  }
  const methodLabel = opts.method === "totp" ? "aplicația de autentificare" : "codul primit pe e-mail";
  const { subject, body } = {
    enabled: {
      subject: "Autentificarea în doi pași a fost activată",
      body: `De acum, la autentificarea în browser îți cerem și un cod (${methodLabel}). Celelalte sesiuni web au fost închise.`,
    },
    disabled: {
      subject: "Autentificarea în doi pași a fost dezactivată",
      body: "De acum, contul tău se deschide în browser doar cu parola.",
    },
    reset: {
      subject: "Autentificarea în doi pași a fost resetată",
      body: "Un administrator a dezactivat autentificarea în doi pași pentru contul tău (de exemplu, după pierderea telefonului). O poți activa din nou din Setări → Contul meu → Securitate.",
    },
  }[opts.event];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a;margin-bottom:16px">${subject}</h2>
      <p>Bună, <strong>${escapeHtml(opts.firstName)}</strong>,</p>
      <p>${body}</p>
      <p style="color:#888;font-size:12px;margin-top:24px">
        Dacă nu ai făcut tu această schimbare, schimbă-ți imediat parola și anunță administratorul firmei.
      </p>
    </div>
  `;
  const info = await t.sendMail({ from: env.SMTP_FROM, ...replyTo(), to: opts.to, subject: `Operio: ${subject.toLowerCase()}`, html });
  console.log(`[email] 2FA notice (${opts.event}) sent to ${mailDomain(opts.to)} — messageId: ${info.messageId}`);
}

/** Demo request from the marketing site → the founder's inbox, reply-to the lead. */
export async function sendContactRequest(req: {
  name: string; company: string; phone: string; email: string; message: string;
  lang: "ro" | "en"; page?: string; ip?: string; userAgent?: string;
}): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // Nu logăm payload-ul (date de contact ale lead-ului).
    console.warn("[email] SMTP not configured — contact request NOT delivered");
    return;
  }
  const esc = (v: string) => v.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const rows: Array<[string, string]> = [
    ["Nume", req.name], ["Firmă", req.company], ["Telefon", req.phone], ["Email", req.email],
    ["Limba", req.lang], ["Pagina", req.page ?? ""], ["IP", req.ip ?? ""], ["Browser", req.userAgent ?? ""],
  ];
  const html = `<h2 style="font-family:sans-serif">Cerere demo Operio</h2>
<table style="font-family:sans-serif;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("")}</table>
${req.message ? `<p style="font-family:sans-serif;white-space:pre-wrap;border-left:3px solid #F5E60D;padding-left:12px">${esc(req.message)}</p>` : ""}
<p style="font-family:sans-serif"><a href="https://wa.me/${req.phone.replace(/\D/g, "").replace(/^0/, "40")}">Răspunde pe WhatsApp</a></p>`;
  await t.sendMail({
    from: env.SMTP_FROM,
    to: env.CONTACT_EMAIL,
    replyTo: `${req.name} <${req.email}>`,
    subject: `Cerere demo: ${req.company} (${req.name})`,
    html,
    text: rows.map(([k, v]) => `${k}: ${v}`).join("\n") + (req.message ? `\n\n${req.message}` : ""),
  });
  console.log("[email] contact request forwarded");
}
