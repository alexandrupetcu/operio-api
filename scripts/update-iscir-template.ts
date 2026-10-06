/**
 * Update the global ISCIR REVIZIE_CENTRALA template with a faithful, XLSX-shaped
 * HTML replica of the client's "RAPORT DE VERIFICARI INCERCARI SI PROBE" form
 * (106. Ristea_Alexe.xlsx). Single A4 page, 11-column grid (A-K), dense bordered
 * layout. Filled values render in the "--fill" color (red) — one CSS variable.
 * Run: npx tsx --env-file=.env scripts/update-iscir-template.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// NOTE: fill-in values are wrapped in <span class="f">…</span> so the whole
// "roșu" is controlled by a single CSS variable (--fill) at the top.
export const TEMPLATE_HTML = `<style>
  body { padding: 2mm !important; }
  .rvip { --fill: #e00; color:#000; font-family: Carlito, Calibri, Arial, sans-serif; }
  .rvip table { border-collapse: collapse !important; width: 100% !important; table-layout: fixed !important; margin: 0 !important; }
  .rvip td, .rvip th { border: 0.75px solid #000 !important; padding: 1.5px 3px !important; font-size: 9.5px !important; line-height: 1.2 !important; vertical-align: middle !important; background: transparent !important; word-wrap: break-word; }
  .rvip .f { color: var(--fill) !important; font-weight: 700; }
  .rvip .c { text-align: center; }
  .rvip .b { font-weight: 700; }
  .rvip .sec { font-weight: 700; font-size: 10.5px !important; }
  .rvip .title { text-align: center; font-weight: 700; font-size: 13px !important; }
  .rvip .sm { font-size: 8px !important; }
  .rvip .dh { text-align: center; font-weight: 700; font-size: 8.5px !important; }
  .rvip .val { text-align: center; }
  .rvip img { max-height: 60px; }
  .rvip tr.pagebreak td { break-before: page; page-break-before: always; }
  /* Separator lines the client asked to drop: both neighbours lose the shared edge. */
  .rvip td.nbt { border-top: none !important; }
  .rvip td.nbb { border-bottom: none !important; }
  .rvip td.nbl { border-left: none !important; }
  .rvip td.nbr { border-right: none !important; }
</style>
<div class="rvip">
<table>
<colgroup>
  <col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:8%">
  <col style="width:9%"><col style="width:9%"><col style="width:16%"><col style="width:16%">
  <col style="width:6%"><col style="width:6%"><col style="width:6%">
</colgroup>

<!-- ===== ANTET ===== -->
<tr>
  <td colspan="3" class="c b" style="line-height:1.7 !important">{{tenant_name}}<br>Autorizație ISCIR<br>NR. {{tenant_iscir_number}} / DATA: {{tenant_iscir_date}}</td>
  <td colspan="5" class="c b"><div class="title" style="margin-bottom:6px">RAPORT DE VERIFICĂRI ÎNCERCĂRI ȘI PROBE</div>Nr. <span class="f">{{nr_inregistrare}}</span> / Data: <span class="f">{{revision_date}}</span></td>
  <td colspan="3" class="sm" style="vertical-align:top !important;line-height:1.7 !important">Înregistrat la : {{tenant_name}}<br>Nr. înregistrare : <span class="f">{{nr_inregistrare}}</span></td>
</tr>

<!-- ===== ADMITEREA FUNCTIONARII ===== -->
<tr>
  <td rowspan="2" class="sm">Admiterea funcționării</td>
  <td>Aparat nou</td>
  <td class="c f">{{device_age_nou}}</td>
  <td colspan="3" rowspan="2" class="c">Verificare tehnică periodică</td>
  <td rowspan="2" class="c f">{{verification_type_periodica}}</td>
  <td colspan="3" rowspan="2" class="sm">Repunere în funcțiune după reparare</td>
  <td rowspan="2" class="c f">{{verification_type_repunere}}</td>
</tr>
<tr>
  <td>Aparat vechi</td>
  <td class="c f">{{device_age_vechi}}</td>
</tr>

<!-- ===== I / II ===== -->
<tr>
  <td colspan="6" class="sec">l. IDENTIFICARE UTILIZATOR:</td>
  <td colspan="5" class="sec">ll. DATE PRIVIND INSTALAȚIA DE ARDERE</td>
</tr>
<tr>
  <td colspan="6" style="vertical-align:top">
    <p style="margin:2px 0">Denumire/ Numele și prenumele: <span class="f">{{client_name}}</span></p>
    <p style="margin:6px 0 2px">Adresa: <span class="f">{{client_city}}, {{client_county}}</span></p>
    <p style="margin:2px 0">Str: <span class="f">{{client_address}}</span></p>
    <p style="margin:2px 0">Tel: <span class="f">{{client_phone}}</span></p>
    <p style="margin:6px 0 2px">Loc de amplasare aparat: <span class="f">{{installation_location}}</span></p>
    <p style="margin:6px 0 2px">Deținător: <span class="f">{{client_name}}</span></p>
  </td>
  <td colspan="5" style="vertical-align:top">
    <p style="margin:2px 0">Producător: <span class="f">{{equipment_name}}</span></p>
    <p style="margin:2px 0">Tip: <span class="f">{{installation_device_type}}</span></p>
    <p style="margin:2px 0">Model: <span class="f">{{equipment_name}}</span></p>
    <p style="margin:2px 0">Serie/an fabricație: <span class="f">{{equipment_serial}}</span></p>
    <p style="margin:2px 0">Putere maximă/ Putere minimă(KW): <span class="f">{{installation_power}}</span></p>
    <p style="margin:2px 0">Cu aer aspirat/insuflat: <span class="f">{{installation_air_supply}}</span></p>
    <p style="margin:2px 0">Tip combustibil: <span class="f">{{installation_fuel_iscir}}</span></p>
    <p style="margin:2px 0">Cu alimentare(*manuală/automată): <span class="f">{{installation_feeding}}</span></p>
    <p style="margin:2px 0" class="sm">*(la cazane cu combustibil solid)</p>
  </td>
</tr>

<!-- ===== III. VERIFICAREA DOCUMENTELOR ===== -->
<tr><td colspan="11" class="sec">lll. VERIFICAREA DOCUMENTELOR</td></tr>
<tr>
  <td colspan="8">Documente</td>
  <td class="dh">DA</td><td class="dh">NU</td><td class="dh">N/A</td>
</tr>
<tr>
  <td rowspan="5" class="c" style="width:8%">Există</td>
  <td colspan="7">Instrucțiuni de instalare, montare, reglare, utilizare și întreținere furnizate de producător</td>
  <td class="val f">{{doc_instructions_da}}</td><td class="val f">{{doc_instructions_nu}}</td><td class="val f">{{doc_instructions_na}}</td>
</tr>
<tr>
  <td colspan="7">Declarație de conformitate pentru instalare/montare/reparare aparat</td>
  <td class="val f">{{doc_conformity_declaration_da}}</td><td class="val f">{{doc_conformity_declaration_nu}}</td><td class="val f">{{doc_conformity_declaration_na}}</td>
</tr>
<tr>
  <td colspan="7">Schemă termomecanică</td>
  <td class="val f">{{doc_thermo_mechanical_schema_da}}</td><td class="val f">{{doc_thermo_mechanical_schema_nu}}</td><td class="val f">{{doc_thermo_mechanical_schema_na}}</td>
</tr>
<tr>
  <td colspan="7">Documentație de reparare</td>
  <td class="val f">{{doc_repair_documentation_da}}</td><td class="val f">{{doc_repair_documentation_nu}}</td><td class="val f">{{doc_repair_documentation_na}}</td>
</tr>
<tr>
  <td colspan="7">Aviz de combustibil</td>
  <td class="val f">{{doc_fuel_notice_da}}</td><td class="val f">{{doc_fuel_notice_nu}}</td><td class="val f">{{doc_fuel_notice_na}}</td>
</tr>

<!-- ===== IV. VERIFICAREA LUCRARILOR EFECTUATE ===== -->
<tr>
  <td colspan="8" class="sec">IV. VERIFICAREA LUCRĂRILOR EFECTUATE</td>
  <td class="dh">DA</td><td class="dh">NU</td><td class="dh">N/A</td>
</tr>
<tr>
  <td colspan="8">Aparatul este instalat/montat conform instrucțiunilor de instalare/montare</td>
  <td class="val f">{{work_installed_correct_da}}</td><td class="val f">{{work_installed_correct_nu}}</td><td class="val f">{{work_installed_correct_na}}</td>
</tr>
<tr>
  <td colspan="8">Aparatul este reparat conform documentației de reparare</td>
  <td class="val f">{{work_repaired_correct_da}}</td><td class="val f">{{work_repaired_correct_nu}}</td><td class="val f">{{work_repaired_correct_na}}</td>
</tr>
<tr>
  <td colspan="4" rowspan="4"></td>
  <td colspan="4">gaze</td>
  <td class="val f">{{work_connection_gas_da}}</td><td class="val f">{{work_connection_gas_nu}}</td><td class="val f">{{work_connection_gas_na}}</td>
</tr>
<tr>
  <td colspan="4">electricitate</td>
  <td class="val f">{{work_connection_electricity_da}}</td><td class="val f">{{work_connection_electricity_nu}}</td><td class="val f">{{work_connection_electricity_na}}</td>
</tr>
<tr>
  <td colspan="4">apă</td>
  <td class="val f">{{work_connection_water_da}}</td><td class="val f">{{work_connection_water_nu}}</td><td class="val f">{{work_connection_water_na}}</td>
</tr>
<tr>
  <td colspan="4">coș de fum evacuare gaze arse</td>
  <td class="val f">{{work_flue_gas_da}}</td><td class="val f">{{work_flue_gas_nu}}</td><td class="val f">{{work_flue_gas_na}}</td>
</tr>
<tr>
  <td colspan="8">Tipul de combustibil disponibil este corespunzător categoriei aparatului</td>
  <td class="val f">{{work_fuel_match_da}}</td><td class="val f">{{work_fuel_match_nu}}</td><td class="val f">{{work_fuel_match_na}}</td>
</tr>
<tr>
  <td colspan="8">Asigurarea aerului de ardere prin priza de aer /tubulatura aer</td>
  <td class="val f">{{work_combustion_air_da}}</td><td class="val f">{{work_combustion_air_nu}}</td><td class="val f">{{work_combustion_air_na}}</td>
</tr>

<!-- ===== V. VERIFICARI FUNCTIONALE ===== -->
<tr><td colspan="11" class="sec">V. VERIFICĂRI FUNCȚIONALE:</td></tr>
<tr>
  <td colspan="8" class="sec">V. 1 VERIFICĂRI LA RECE</td>
  <td class="dh">DA</td><td class="dh">NU</td><td class="dh">N/A</td>
</tr>
<tr>
  <td colspan="8">Verificare etanșeitate</td>
  <td class="val f">{{verif_fuel_sealing}}</td><td></td><td></td>
</tr>
<tr>
  <td colspan="8">- circuit combustibil (presiune statică <span class="f">{{verif_fuel_static_pressure}}</span> mbar)</td>
  <td class="val f">{{verif_fuel_sealing}}</td><td></td><td></td>
</tr>
<tr>
  <td colspan="8">-circuit apă(presiune de încercare <span class="f">{{verif_water_pressure_test}}</span> bar/timp încercare <span class="f">{{verif_water_pressure_time}}</span> minute) (unde este cazul)</td>
  <td class="val f">{{verif_water_sealing}}</td><td></td><td></td>
</tr>
<tr>
  <td colspan="8">Verificare instalație electrică - tensiune <span class="f">{{verif_electrical_voltage}}</span> V</td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr>
  <td colspan="8">Verificarea legării la pământ</td>
  <td class="val f">{{verif_grounding}}</td><td></td><td></td>
</tr>

<!-- ===== V.2 ===== -->
<tr>
  <td colspan="6" class="sec">V.2 REGLAT SARCINĂ APARAT <span class="f">{{verif_load_setting}}</span> %</td>
  <td colspan="2" class="c">Valori măsurate</td>
  <td class="dh">DA</td><td class="dh">NU</td><td class="dh">N/A</td>
</tr>

<!-- ===== V.3 VERIFICARI LA CALD ===== -->
<tr><td colspan="6" class="sec">V.3 VERIFICĂRI LA CALD</td><td colspan="2"></td><td class="val f">{{verif_flue_gas_sealing}}</td><td></td><td></td></tr>
<tr>
  <td colspan="6">Tiraj: {{verif_draft_natural}} natural / forțat {{verif_draft_fortat}} (mbar)</td>
  <td colspan="2"></td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr><td colspan="6">Presiunea gazului la intrare pe rampa de gaz(mbar)</td><td colspan="2" class="val f">{{verif_gas_pressure_ramp}}</td><td class="val">X</td><td></td><td></td></tr>
<tr><td colspan="6">Presiunea gazului la intrarea în arzător(mbar)</td><td colspan="2" class="val f">{{verif_gas_pressure_burner}}</td><td class="val">X</td><td></td><td></td></tr>
<tr><td colspan="6">Presiunea gazului la intrare în focar(mbar)</td><td colspan="2" class="val f">{{verif_gas_pressure_focus}}</td><td class="val">X</td><td></td><td></td></tr>
<tr><td colspan="6">Temperatura gazelor arse(°C)</td><td colspan="2" class="val f">{{readings_t_gaz}}</td><td class="val">X</td><td></td><td></td></tr>
<tr><td colspan="6">Verificarea etanșeității circuitului de gaze arse</td><td colspan="2"></td><td class="val">X</td><td></td><td></td></tr>
<tr><td colspan="6">Alte măsurători</td><td colspan="2"></td><td></td><td></td><td class="val">X</td></tr>
<tr><td colspan="6">Verificarea funcțiilor de protecție aparat și instalații anexe</td><td colspan="2"></td><td class="val f">{{verif_protection_functions}}</td><td></td><td></td></tr>

<!-- ===== Verificarea parametrilor realizati ===== -->
<tr>
  <td colspan="2" rowspan="2" class="c">Verificarea parametrilor realizați</td>
  <td colspan="2" class="c">Presiunea agentului termic</td>
  <td colspan="2" class="c">Temperatura agentului termic(°C)</td>
  <td class="c sm">Valori limită confort</td>
  <td class="c sm">Valori măsurate</td>
  <td class="dh">DA</td><td class="dh">NU</td><td class="dh">N/A</td>
</tr>
<tr>
  <td>Apă {{verif_water_pressure_fill}}</td><td>Abur .....</td>
  <td>Apă tur/retur {{verif_water_temp_flow_fill}}</td><td>Aer cald .....</td>
  <td>{{verif_comfort_limits}}</td><td></td>
  <td class="val">DA</td><td></td><td></td>
</tr>

<!-- ===== Analiza gazelor arse ===== -->
<tr>
  <td colspan="4" rowspan="7" class="sm" style="vertical-align:top">
    <p style="margin:2px 0" class="b">Analiza gazelor arse **)</p>
    <p style="margin:6px 0 2px">Analiza s-a realizat cu un analizator tip <span class="f">{{analyzer_name}}</span></p>
    <p style="margin:6px 0 2px">Seria S.N. : <span class="f">{{analyzer_serial}}</span></p>
    <p style="margin:6px 0 2px">Verificarea metrologică expiră la data de <span class="f">{{analyzer_metrology_expiry}}</span></p>
  </td>
  <td colspan="2">Co măsurat (mg/m3)</td>
  <td>100mg/m3</td><td class="val f">{{readings_co}}</td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr>
  <td colspan="2">O2 măsurat %</td>
  <td></td><td class="val f">{{readings_o2}}</td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr>
  <td colspan="2">NO2(x)măsurat (mg/m3)</td>
  <td>350mg/m3</td><td class="val f">{{readings_nox}}</td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr>
  <td colspan="2">SO2(x)măsurat(ppm)</td>
  <td></td><td></td>
  <td></td><td></td><td class="val">X</td>
</tr>
<tr>
  <td colspan="2">CO2 %</td>
  <td></td><td class="val f">{{readings_co2}}</td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr>
  <td colspan="2">Exces de aer</td>
  <td></td><td class="val f">{{readings_excess_air}}</td>
  <td class="val">X</td><td></td><td></td>
</tr>
<tr>
  <td colspan="2">Eficiența de ardere %</td>
  <td></td><td class="val f">{{readings_es}}</td>
  <td class="val">X</td><td></td><td></td>
</tr>

<tr><td colspan="11" class="sm nbb">*)Se precizează norma aplicabilă</td></tr>
<tr><td colspan="11" class="sm nbt">**)Se anexează buletinul de analiză a gazelor arse</td></tr>

<!-- ===== VI. CONCLUZII ===== -->
<tr class="pagebreak"><td colspan="11" class="sec">Vl. CONCLUZII: Aparatul [<span class="f">{{decision_admis}}</span>] îndeplinește / [<span class="f">{{decision_respins}}</span>] nu îndeplinește condițiile de funcționare, conform prevederilor prescripției tehnice A1/2010:</td></tr>
<tr>
  <td class="c b nbb" style="white-space:nowrap">[ <span class="f">{{decision_admis}}</span> ]</td>
  <td colspan="10" class="nbb">ADMIS-aparatul poate funcționa până la scadența următoarei verificări, cu obligația respectării instrucțiunilor de instalare, reglare, utilizare și întreținere date de producător și a prevederilor prescripției tehnice A1</td>
</tr>
<tr>
  <td class="c b nbt" style="white-space:nowrap">[ <span class="f">{{decision_respins}}</span> ]</td>
  <td colspan="10" class="nbt">RESPINS- aparatul nu îndeplinește condițiile de punere în funcțiune și se interzice funcționarea acestuia</td>
</tr>
<tr><td colspan="11">SCADENȚA următoarei verificări este la 2 ani de la prezenta verificare, la data de <span class="f">{{next_revision_date}}</span></td></tr>
<tr><td colspan="11" style="padding:8px 3px !important">Numele și prenumele "RSL IP" - <span class="f">{{operator_name}}</span></td></tr>
<tr><td colspan="11" class="nbb" style="padding:8px 3px !important">Numele și prenumele utilizatorului <span class="f">{{client_name}}</span></td></tr>
<tr><td colspan="11" class="nbt nbb" style="padding:8px 3px !important">Numele și prenumele personalului instruit <span class="f">{{client_name}}</span></td></tr>
<tr><td colspan="11" class="nbt" style="padding:8px 3px !important">Am fost instruit(semnătura) {{client_signature}}</td></tr>

<!-- ===== SEMNATURI ===== -->
<tr><td colspan="11" class="sec nbb">SEMNĂTURI:</td></tr>
<tr>
  <td colspan="3" class="sm c nbb nbt nbr">Persoana juridică autorizată (numele și prenumele, semnătura și ștampila)</td>
  <td colspan="2" class="sm c nbb nbt nbl nbr">RVT (numele și prenumele, semnătura și ștampila)</td>
  <td colspan="3" class="sm c nbb nbt nbl nbr">Deținător/Utilizator (numele și prenumele, semnătura și ștampila) (după caz)</td>
  <td colspan="3" class="sm c nbb nbt nbl">RSVTI*) (numele și prenumele, semnătura și ștampila)</td>
</tr>
<tr style="height:60px">
  <td colspan="3" class="c nbt nbb nbr" style="vertical-align:top"><span class="f b">{{tenant_name}}</span><br>{{tenant_stamp}}</td>
  <td colspan="2" class="c nbt nbb nbl nbr" style="vertical-align:top"><span class="f b">{{rvt_nume}}</span></td>
  <td colspan="3" class="c nbt nbb nbl nbr" style="vertical-align:top"><span class="f b">{{client_name}}</span><br>{{client_signature}}</td>
  <td colspan="3" class="nbt nbb nbl" style="vertical-align:top"></td>
</tr>
<tr><td colspan="11" class="sm nbt">*)În cazul instituțiilor de interes public</td></tr>

<!-- ===== NOTE ===== -->
<tr><td colspan="11" class="b">Notă:</td></tr>
<tr><td colspan="11" class="sm nbb">1) Orice înregistrare negativă duce la sistarea procedurii de punere în funcțiune a aparatului până la remedierea neconformității</td></tr>
<tr><td colspan="11" class="sm nbt nbb">2) Orice schimbare a amplasamentului aparatului necesită o nouă verificare</td></tr>
<tr><td colspan="11" class="sm nbt">3) Prezentul formular se emite în 2 (două) exemplare/aparat, un exemplar pentru deținătorul/ utilizatorul aparatului și un exemplar pentru persoana juridică autorizată</td></tr>

</table>
</div>`;

async function main() {
  const template = await prisma.documentTemplate.findFirst({
    where: { tenantId: null, categoryCode: "REVIZIE_CENTRALA" },
  });

  if (!template) {
    console.error("No global REVIZIE_CENTRALA template found. Create one first.");
    process.exit(1);
  }

  await prisma.documentTemplate.update({
    where: { id: template.id },
    data: {
      name: "Raport Revizie Centrală (ISCIR)",
      description: "Raport oficial conform prescripției tehnice A1/2010 — layout fidel formei clientului (XLSX)",
      content: TEMPLATE_HTML,
    },
  });

  console.log(`Updated template: ${template.id}`);
}

// Only run when executed directly (so the template can be imported for testing).
if (process.argv[1] && process.argv[1].includes("update-iscir-template")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
