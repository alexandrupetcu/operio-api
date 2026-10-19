import { describe, expect, it } from "vitest";
import { certificationBucket } from "./certification-bucket.js";

describe("certificationBucket", () => {
  it("praguri: fereastra firmei, 30, 7, ziua expirării, expirat", () => {
    expect(certificationBucket(45, 60)).toBe("w60");
    expect(certificationBucket(30, 60)).toBe("d30");
    expect(certificationBucket(8, 60)).toBe("d30");
    expect(certificationBucket(7, 60)).toBe("d7");
    expect(certificationBucket(0, 60)).toBe("d0");
    expect(certificationBucket(-1, 60)).toBe("expired");
  });
});
