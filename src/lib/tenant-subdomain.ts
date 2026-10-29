/**
 * Subdomeniul unei firme (`picinstall.operio.ro`): aceeași aplicație, cu sigla și numele
 * firmei pe pagina de autentificare. Îl activează doar master adminul (Firme → firmă).
 * E doar o adresă — izolarea datelor rămâne cea din baza de date / sesiune.
 */
/** Nume care nu pot fi subdomeniu de firmă (servicii ale noastre sau înșelătoare). */
export const RESERVED_SUBDOMAINS = new Set([
  "app", "api", "www", "mail", "smtp", "imap", "pop", "ftp", "admin", "master", "static", "assets",
  "cdn", "status", "docs", "help", "support", "blog", "dev", "staging", "test", "demo", "operio",
]);

/** Mesajul de eroare (în română) sau null dacă subdomeniul e bun. */
export function subdomainError(value: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(value))
    return "Subdomeniul are 3–40 caractere: litere mici, cifre și cratimă (nu la început sau la sfârșit)";
  if (RESERVED_SUBDOMAINS.has(value)) return `„${value}” e rezervat`;
  return null;
}

/** „picinstall.operio.ro” → „picinstall”; orice altceva (app., domenii străine, două niveluri) → null. */
export function subdomainFromHost(host: string | undefined, baseDomain: string | undefined): string | null {
  if (!host || !baseDomain) return null;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const sub = h.slice(0, -suffix.length);
  return sub && !sub.includes(".") && !subdomainError(sub) ? sub : null;
}

/** Adresa aplicației pentru o firmă: subdomeniul ei, dacă are, altfel aplicația comună. */
export function appUrlFor(
  subdomain: string | null | undefined,
  baseDomain: string | undefined,
  frontendUrl: string,
): string {
  if (subdomain && baseDomain) return `https://${subdomain}.${baseDomain}`;
  return frontendUrl.replace(/\/$/, "");
}
