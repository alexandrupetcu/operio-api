import { describe, expect, it } from "vitest";
import {
  ImportFileError,
  MAX_FILE_BYTES,
  MAX_ROWS,
  TARGET_FIELDS,
  detectDelimiter,
  normalizeHeader,
  parseImportDate,
  parseUpload,
  phoneKey,
  splitPersonName,
  suggestMapping,
  zipUncompressedSize,
} from "./clients-import.js";

const csv = (text: string) => Buffer.from(text, "utf8");

describe("normalizeHeader", () => {
  it("minuscule, fără diacritice, fără punctuație", () => {
    expect(normalizeHeader("Telefon mobil")).toBe("telefon mobil");
    expect(normalizeHeader("Adresă")).toBe("adresa");
    expect(normalizeHeader("Judeţ")).toBe("judet");
    expect(normalizeHeader("JUDEȚ")).toBe("judet");
    expect(normalizeHeader("Nr. Tel.")).toBe("nr tel");
    expect(normalizeHeader("E-Mail")).toBe("e mail");
  });

  it("sedila și virgulița dau același rezultat", () => {
    expect(normalizeHeader("Judeţ")).toBe(normalizeHeader("Județ"));
    expect(normalizeHeader("Ultima reviziţie")).toBe(normalizeHeader("Ultima reviziție"));
  });

  it("colapsează spațiile și taie capetele", () => {
    expect(normalizeHeader("  Cod   Client  ")).toBe("cod client");
  });
});

describe("suggestMapping — antet → câmp, insensibil la diacritice", () => {
  it("antetul tipic al unei evidențe de firmă", () => {
    const headers = ["Nume client", "Telefon", "Adresă", "Judeţ", "Localitate", "Ultima revizie", "Observatii"];
    const m = suggestMapping(headers);
    expect(m.name).toBe(0);
    expect(m.phone).toBe(1);
    expect(m.address).toBe(2);
    expect(m.county).toBe(3);
    expect(m.city).toBe(4);
    expect(m.lastRevisionDate).toBe(5);
    expect(m.notes).toBe(6);
  });

  it("datele au prioritate față de câmpurile generice", () => {
    // „Ultima revizie" trebuie să nimerească lastRevisionDate, nu altceva, iar
    // „Data verificării instalaţiei" trebuie să nimerească lastInstalatieDate.
    const m = suggestMapping(["Nume", "Data verificării instalaţiei", "Ultima revizie"]);
    expect(m.lastInstalatieDate).toBe(1);
    expect(m.lastRevisionDate).toBe(2);
  });

  it("POD / cod client / CUI / e-mail", () => {
    const m = suggestMapping(["Denumire", "CUI", "POD", "Cod client", "E-mail"]);
    expect(m.name).toBe(0);
    expect(m.cui).toBe(1);
    expect(m.pod).toBe(2);
    expect(m.codClient).toBe(3);
    expect(m.email).toBe(4);
  });

  it("variantele de nume pentru client", () => {
    for (const h of ["Nume", "Client", "Denumire", "Firma", "Beneficiar", "Titular", "Abonat", "Name"]) {
      expect(suggestMapping([h]).name, h).toBe(0);
    }
  });

  it("variantele de telefon", () => {
    for (const h of ["Telefon", "Tel", "Mobil", "Phone", "Nr tel", "Numar telefon"]) {
      expect(suggestMapping([h]).phone, h).toBe(0);
    }
  });

  it("o coloană nu e atribuită de două ori", () => {
    const m = suggestMapping(["Telefon", "Telefon"]);
    const used = Object.values(m).filter((v): v is number => v !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  it("antet necunoscut → toate câmpurile null", () => {
    const m = suggestMapping(["Coloana 1", "Zzz"]);
    for (const f of TARGET_FIELDS) expect(m[f], f).toBeNull();
  });

  it("întoarce o cheie pentru fiecare câmp țintă", () => {
    expect(Object.keys(suggestMapping([])).sort()).toEqual([...TARGET_FIELDS].sort());
  });
});

describe("parseImportDate", () => {
  const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  it("dd.mm.yyyy / dd/mm/yyyy / dd-mm-yyyy", () => {
    expect(ymd(parseImportDate("18.10.2026"))).toBe("2026-10-18");
    expect(ymd(parseImportDate("18/10/2026"))).toBe("2026-10-18");
    expect(ymd(parseImportDate("18-10-2026"))).toBe("2026-10-18");
    expect(ymd(parseImportDate("1.2.2026"))).toBe("2026-02-01");
  });

  it("an pe două cifre → 20xx", () => {
    expect(ymd(parseImportDate("18/10/26"))).toBe("2026-10-18");
    expect(ymd(parseImportDate("01.01.99"))).toBe("2099-01-01");
  });

  it("yyyy-mm-dd și ISO complet", () => {
    expect(ymd(parseImportDate("2026-10-18"))).toBe("2026-10-18");
    expect(ymd(parseImportDate("2026-10-18T09:30:00Z"))).toBe("2026-10-18");
    expect(ymd(parseImportDate("2026-10-18 09:30"))).toBe("2026-10-18");
  });

  it("serial Excel (zile de la 30.12.1899)", () => {
    expect(ymd(parseImportDate("45000"))).toBe("2023-03-15");
    expect(ymd(parseImportDate("45200"))).toBe("2023-10-01");
    expect(ymd(parseImportDate("45000.5"))).toBe("2023-03-15"); // fracția de zi se taie
  });

  it("numerele din afara intervalului 1990–2100 nu sunt date (pot fi coduri)", () => {
    expect(parseImportDate("1234")).toBeNull(); // sub 32874
    expect(parseImportDate("32873")).toBeNull();
    expect(parseImportDate("73416")).toBeNull();
    expect(parseImportDate("123456")).toBeNull(); // 6 cifre, peste plafon
  });

  it("intervalul de serial acceptat la capete", () => {
    expect(ymd(parseImportDate("32874"))).toBe("1990-01-01");
    expect(ymd(parseImportDate("73415"))).toBe("2100-12-31");
  });

  it("respinge datele imposibile", () => {
    expect(parseImportDate("32.01.2026")).toBeNull();
    expect(parseImportDate("31.02.2026")).toBeNull(); // 31 februarie
    expect(parseImportDate("18.13.2026")).toBeNull();
    expect(parseImportDate("18.10.1800")).toBeNull();
    expect(parseImportDate("18.10.2200")).toBeNull();
  });

  it("text gol / fără legătură → null", () => {
    expect(parseImportDate("")).toBeNull();
    expect(parseImportDate("   ")).toBeNull();
    expect(parseImportDate("anul trecut")).toBeNull();
    expect(parseImportDate("18.10")).toBeNull();
  });

  it("spațiile din jur se ignoră", () => {
    expect(ymd(parseImportDate("  18.10.2026  "))).toBe("2026-10-18");
  });

  it("întoarce o dată în UTC (fără deplasare de fus la stocare)", () => {
    const d = parseImportDate("18.10.2026")!;
    expect(d.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });
});

describe("splitPersonName — ultimul token e numele de familie", () => {
  it("două tokenuri", () => {
    expect(splitPersonName("Ion Popescu")).toEqual({ firstName: "Ion", lastName: "Popescu" });
  });

  it("trei tokenuri: primele două rămân prenume", () => {
    expect(splitPersonName("Popescu Ion Marian")).toEqual({ firstName: "Popescu Ion", lastName: "Marian" });
  });

  it("un singur token → doar nume de familie", () => {
    expect(splitPersonName("Popescu")).toEqual({ firstName: null, lastName: "Popescu" });
  });

  it("spațiile multiple și capetele se normalizează", () => {
    expect(splitPersonName("  Ion   Popescu  ")).toEqual({ firstName: "Ion", lastName: "Popescu" });
  });

  it("nume gol → lastName gol, fără excepție", () => {
    expect(splitPersonName("")).toEqual({ firstName: null, lastName: "" });
    expect(splitPersonName("   ")).toEqual({ firstName: null, lastName: "" });
  });

  it("nume compus cu cratimă rămâne un singur token", () => {
    expect(splitPersonName("Ana-Maria Ionescu")).toEqual({ firstName: "Ana-Maria", lastName: "Ionescu" });
  });
});

describe("phoneKey — cheie de comparare pentru dubluri", () => {
  it("formele românești ale aceluiași număr dau aceeași cheie", () => {
    const expected = "0721234567";
    for (const raw of ["0721234567", "0721 234 567", "+40721234567", "0040721234567", "40721234567", "721234567", "(0721) 234-567"]) {
      expect(phoneKey(raw), raw).toBe(expected);
    }
  });

  it("numerele prea scurte nu produc cheie (nu generează dubluri false)", () => {
    expect(phoneKey("12345")).toBeNull();
    expect(phoneKey("-")).toBeNull();
    expect(phoneKey("")).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey(undefined)).toBeNull();
  });

  it("un fix de 6 cifre e acceptat", () => {
    expect(phoneKey("021 123")).toBe("021123");
  });
});

describe("detectDelimiter", () => {
  it("alege separatorul cel mai frecvent din primul rând", () => {
    expect(detectDelimiter("a;b;c;d")).toBe(";");
    expect(detectDelimiter("a,b,c,d")).toBe(",");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("`;` câștigă peste virgula zecimală din date", () => {
    expect(detectDelimiter("Nume;Telefon;Ultima revizie")).toBe(";");
  });

  it("un singur câmp → implicit virgulă", () => {
    expect(detectDelimiter("Nume")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("parseUpload — CSV", () => {
  it("antet + rânduri, lățime uniformizată", async () => {
    const sheet = await parseUpload(csv("Nume;Telefon\nIon Popescu;0721234567\nMaria;\n"), "clienti.csv", "text/csv");
    expect(sheet.headers).toEqual(["Nume", "Telefon"]);
    expect(sheet.rows).toEqual([
      ["Ion Popescu", "0721234567"],
      ["Maria", ""],
    ]);
  });

  it("coloanele lipsă se completează cu gol până la lățimea maximă", async () => {
    const sheet = await parseUpload(csv("Nume;Telefon;Adresa\nIon;0721234567\n"), "c.csv", "text/csv");
    expect(sheet.rows[0]).toEqual(["Ion", "0721234567", ""]);
  });

  it("antetul gol se numește „Coloana N”", async () => {
    const sheet = await parseUpload(csv("Nume;;Adresa\nIon;x;y\n"), "c.csv", "text/csv");
    expect(sheet.headers).toEqual(["Nume", "Coloana 2", "Adresa"]);
  });

  it("ghilimelele, separatorul în câmp și `\"\"` ca escape", async () => {
    const sheet = await parseUpload(csv('Nume;Adresa\n"Popescu; Ion";"Str. ""A"" nr. 1"\n'), "c.csv", "text/csv");
    expect(sheet.rows[0]).toEqual(["Popescu; Ion", 'Str. "A" nr. 1']);
  });

  it("rândurile complet goale se sar", async () => {
    const sheet = await parseUpload(csv("Nume;Telefon\n\n;\nIon;1234567\n"), "c.csv", "text/csv");
    expect(sheet.rows).toEqual([["Ion", "1234567"]]);
  });

  it("BOM-ul UTF-8 nu ajunge în primul antet", async () => {
    const sheet = await parseUpload(csv("﻿Nume;Telefon\nIon;1234567\n"), "c.csv", "text/csv");
    expect(sheet.headers[0]).toBe("Nume");
  });

  it("CSV cu virgulă ca separator", async () => {
    const sheet = await parseUpload(csv("Nume,Telefon\nIon,0721234567\n"), "c.csv", "text/csv");
    expect(sheet.headers).toEqual(["Nume", "Telefon"]);
  });
});

describe("parseUpload — plafoane și erori", () => {
  it("fișier gol", async () => {
    await expect(parseUpload(Buffer.alloc(0), "c.csv", "text/csv")).rejects.toThrow(ImportFileError);
    await expect(parseUpload(Buffer.alloc(0), "c.csv", "text/csv")).rejects.toThrow("Fișierul este gol");
  });

  it("peste 5 MB", async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x41);
    await expect(parseUpload(big, "c.csv", "text/csv")).rejects.toThrow(/depășește 5 MB/);
  });

  it("fișier fără date (doar linii goale)", async () => {
    await expect(parseUpload(csv("\n\n\n"), "c.csv", "text/csv")).rejects.toThrow(/nu conține date/);
  });

  it(".xls (Excel 97-2003) e refuzat cu mesaj clar", async () => {
    await expect(parseUpload(csv("Nume;Telefon\nIon;1\n"), "vechi.xls", "application/vnd.ms-excel")).rejects.toThrow(
      /Formatul \.xls \(Excel 97-2003\) nu este acceptat/,
    );
  });

  it("exact MAX_ROWS rânduri de date trec", async () => {
    const body = ["Nume;Telefon", ...Array.from({ length: MAX_ROWS }, (_, i) => `Client ${i};072000${i}`)].join("\n");
    const sheet = await parseUpload(csv(body), "c.csv", "text/csv");
    expect(sheet.rows.length).toBe(MAX_ROWS);
  });

  it("MAX_ROWS + 1 rânduri → eroare cu limita în mesaj", async () => {
    const body = ["Nume;Telefon", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `Client ${i};072000${i}`)].join("\n");
    await expect(parseUpload(csv(body), "c.csv", "text/csv")).rejects.toThrow(
      new RegExp(`peste ${MAX_ROWS} rânduri`),
    );
  });

  it("parserul se oprește la plafon — nu parcurge un fișier mult mai mare", async () => {
    // 20 000 de rânduri: eroarea vine imediat, nu după conversia tuturor.
    const body = ["Nume;Telefon", ...Array.from({ length: 20_000 }, (_, i) => `Client ${i};072000${i}`)].join("\n");
    const t0 = performance.now();
    await expect(parseUpload(csv(body), "c.csv", "text/csv")).rejects.toThrow(ImportFileError);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe("zipUncompressedSize — apărare împotriva unui „zip bomb”", () => {
  it("buffer prea scurt / fără director central → null (tratat ca prea mare)", () => {
    expect(zipUncompressedSize(Buffer.alloc(0))).toBeNull();
    expect(zipUncompressedSize(Buffer.alloc(10))).toBeNull();
    expect(zipUncompressedSize(Buffer.from("not a zip at all, really"))).toBeNull();
  });

  it("un ZIP valid cu o intrare → suma dimensiunilor dezarhivate", () => {
    // Director central cu o intrare de 1 234 de octeți dezarhivați.
    const name = Buffer.from("a.txt");
    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(1234, 24); // uncompressed size
    cd.writeUInt16LE(name.length, 28);
    name.copy(cd, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10); // entries
    eocd.writeUInt32LE(cd.length, 12); // cd size
    eocd.writeUInt32LE(0, 16); // cd offset

    expect(zipUncompressedSize(Buffer.concat([cd, eocd]))).toBe(1234);
  });

  it("ZIP64 (markeri 0xffff / 0xffffffff) → null", () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 10);
    expect(zipUncompressedSize(eocd)).toBeNull();
  });

  it("un director central care iese din buffer → null", () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(9999, 12); // cd size peste lungimea bufferului
    eocd.writeUInt32LE(0, 16);
    expect(zipUncompressedSize(eocd)).toBeNull();
  });
});
