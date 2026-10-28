import { describe, it, expect } from "vitest";
import { mergeStepOutputs } from "./project-step-outputs.js";

describe("mergeStepOutputs — datele din pașii workflow-ului, înainte de derivări", () => {
  it("un pas completează ce lipsește din proiect, inclusiv câmpurile goale", () => {
    const { meta } = mergeStepOutputs({ project_length: "", cod_atr: "ATR 1" }, [
      { code: "date_tehnice", output: { project_length: "12.5", cod_atr: "ATR 2", tronsoane: "X | Y | | | 63 | PE | 12.5 |" } },
    ]);
    expect(meta.project_length).toBe("12.5");
    // Valoarea completată pe proiect (editorul de dosar) are prioritate.
    expect(meta.cod_atr).toBe("ATR 1");
    expect(meta.tronsoane).toBe("X | Y | | | 63 | PE | 12.5 |");
  });

  it("datele din formularele workflow-ului (ISO) ajung ca zz.ll.aaaa", () => {
    const { meta } = mergeStepOutputs({}, [{ code: "s", output: { pv_data: "2026-07-22", nota: "2026-07-22 la ora 10" } }]);
    expect(meta.pv_data).toBe("22.07.2026");
    expect(meta.nota).toBe("2026-07-22 la ora 10");
  });

  it("păstrează și cheile cu prefixul pasului; pașii de mai târziu bat pe cei anteriori", () => {
    const { meta, prefixed } = mergeStepOutputs({}, [
      { code: "a", output: { x: "1" } },
      { code: "b", output: { x: "2" } },
    ]);
    expect(meta.x).toBe("2");
    expect(prefixed).toMatchObject({ "a.x": "1", "b.x": "2" });
  });

  it("cheile rezervate (tenant_*, semnături) nu trec din formulare", () => {
    const { meta } = mergeStepOutputs({}, [{ code: "s", output: { tenant_name: "Alta", rte_signature: "k" } }]);
    expect(meta.tenant_name).toBeUndefined();
    expect(meta.rte_signature).toBeUndefined();
  });
});

describe("STEP_OUTPUT_INSTANCE_STATUSES", () => {
  it("include instanțele active (workflow-ul principal al proiectului e „active” până la final)", async () => {
    const { STEP_OUTPUT_INSTANCE_STATUSES } = await import("./project-step-outputs.js");
    expect(STEP_OUTPUT_INSTANCE_STATUSES).toEqual(expect.arrayContaining(["active", "running", "completed"]));
  });
});
