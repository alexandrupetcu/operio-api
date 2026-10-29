import { describe, expect, it } from "vitest";
import { appUrlFor, subdomainFromHost, subdomainError } from "./tenant-subdomain.js";

describe("subdomeniul firmei", () => {
  it("validare: litere mici, cifre și cratimă, 3–40, fără nume rezervate", () => {
    expect(subdomainError("picinstall")).toBeNull();
    expect(subdomainError("pic-install2")).toBeNull();
    expect(subdomainError("Pic")).not.toBeNull();
    expect(subdomainError("ab")).not.toBeNull();
    expect(subdomainError("-pic")).not.toBeNull();
    expect(subdomainError("pic_install")).not.toBeNull();
    for (const r of ["app", "api", "www", "mail", "admin"]) expect(subdomainError(r)).not.toBeNull();
  });

  it("din host: doar subdomeniile directe ale domeniului de bază", () => {
    expect(subdomainFromHost("picinstall.operio.ro", "operio.ro")).toBe("picinstall");
    expect(subdomainFromHost("PicInstall.operio.ro:443", "operio.ro")).toBe("picinstall");
    expect(subdomainFromHost("app.operio.ro", "operio.ro")).toBeNull();
    expect(subdomainFromHost("operio.ro", "operio.ro")).toBeNull();
    expect(subdomainFromHost("a.b.operio.ro", "operio.ro")).toBeNull();
    expect(subdomainFromHost("picinstall.evil.ro", "operio.ro")).toBeNull();
    expect(subdomainFromHost("picinstall.operio.ro", undefined)).toBeNull();
  });

  it("linkurile din e-mailuri duc la adresa firmei, altfel la aplicația comună", () => {
    expect(appUrlFor("picinstall", "operio.ro", "https://app.operio.ro")).toBe("https://picinstall.operio.ro");
    expect(appUrlFor(null, "operio.ro", "https://app.operio.ro/")).toBe("https://app.operio.ro");
    expect(appUrlFor("picinstall", undefined, "http://localhost:5173")).toBe("http://localhost:5173");
  });
});
