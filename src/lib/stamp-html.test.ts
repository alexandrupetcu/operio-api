import { describe, expect, it } from "vitest";
import { stampWithSignatureHtml } from "./stamp-html.js";

describe("stampWithSignatureHtml", () => {
  it("ștampilă + semnătură: semnătura suprapusă, ca la ștampila firmei", () => {
    const html = stampWithSignatureHtml("https://s3/st.png", "https://s3/sig.png", { alt: "Ștampilă RVT" })!;
    expect(html).toContain('alt="Ștampilă RVT"');
    expect(html).toContain("position:absolute");
    expect(html.match(/<img/g)).toHaveLength(2);
  });

  it("doar una dintre ele → o singură imagine, fără suprapunere; niciuna → null", () => {
    expect(stampWithSignatureHtml("https://s3/st.png", null, { alt: "x" })).not.toContain("position:absolute");
    expect(stampWithSignatureHtml(null, "https://s3/sig.png", { alt: "x" })).toContain("Semnătură");
    expect(stampWithSignatureHtml(null, null, { alt: "x" })).toBeNull();
  });

  it("escapează URL-ul și textul alternativ", () => {
    const html = stampWithSignatureHtml('https://s3/a.png?x="><script>', null, { alt: '<b>"' })!;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
  });
});
