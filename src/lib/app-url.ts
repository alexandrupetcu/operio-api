/**
 * Linkul absolut spre aplicație pentru e-mailuri: notificările țin căi relative
 * („/projects/…”, „/calendar”), care într-un client de e-mail nu duc nicăieri.
 * „/dashboard” (folosit de notificările vechi) nu e o rută — panoul e „/”.
 */
export function appUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const path = url === "/dashboard" || url.startsWith("/dashboard?") ? url.replace("/dashboard", "/") : url;
  return new URL(path.startsWith("/") ? path : `/${path}`, base.endsWith("/") ? base : `${base}/`).toString();
}
