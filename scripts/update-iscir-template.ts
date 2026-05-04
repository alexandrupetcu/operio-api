/**
 * Update the global ISCIR REVIZIE_CENTRALA template with full XLSX-based HTML.
 * Run: npx tsx --env-file=.env scripts/update-iscir-template.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TEMPLATE_HTML = `<h1 style="text-align:center">RAPORT DE VERIFICĂRI, ÎNCERCĂRI ȘI PROBE</h1>
<p style="text-align:center"><strong>{{tenant_name}}</strong></p>
<p style="text-align:center">Autorizație ISCIR Nr. {{tenant_iscir_number}} / Data: {{tenant_iscir_date}}</p>
<p style="text-align:center">Nr. înregistrare: {{nr_inregistrare}} / Data: {{revision_date}}</p>

<table>
<tr>
  <td><strong>Aparat nou</strong> [ {{device_age_nou}} ]</td>
  <td><strong>Aparat vechi</strong> [ {{device_age_vechi}} ]</td>
</tr>
<tr>
  <td><strong>Verificare tehnică periodică</strong> [ {{verification_type_periodica}} ]</td>
  <td><strong>Repunere în funcțiune după reparare</strong> [ {{verification_type_repunere}} ]</td>
</tr>
</table>

<hr>

<h2>I. IDENTIFICARE UTILIZATOR</h2>
<p><strong>Denumire / Numele și prenumele:</strong> {{client_name}}</p>
<p><strong>Adresa:</strong> {{client_address}}, {{client_city}}, {{client_county}}</p>
<p><strong>Telefon:</strong> {{client_phone}}</p>
<p><strong>Loc de amplasare aparat:</strong> {{installation_location}}</p>
<p><strong>Deținător:</strong> {{client_name}}</p>

<h2>II. DATE PRIVIND INSTALAȚIA DE ARDERE</h2>
<table>
  <tr><td style="border:1px solid #ccc;padding:6px;width:40%"><strong>Producător:</strong></td><td style="border:1px solid #ccc;padding:6px">{{equipment_name}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Tip:</strong></td><td style="border:1px solid #ccc;padding:6px">{{installation_device_type}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Model:</strong></td><td style="border:1px solid #ccc;padding:6px">{{equipment_name}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Serie / An fabricație:</strong></td><td style="border:1px solid #ccc;padding:6px">{{equipment_serial}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Putere maximă / minimă (KW):</strong></td><td style="border:1px solid #ccc;padding:6px">{{installation_power}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Cu aer aspirat / insuflat:</strong></td><td style="border:1px solid #ccc;padding:6px">{{installation_air_supply}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Tip combustibil:</strong></td><td style="border:1px solid #ccc;padding:6px">{{installation_fuel_iscir}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px"><strong>Cu alimentare (manuală / automată):</strong></td><td style="border:1px solid #ccc;padding:6px">{{installation_feeding}}</td></tr>
</table>

<h2>III. VERIFICAREA DOCUMENTELOR</h2>
<table>
  <tr>
    <th style="border:1px solid #ccc;padding:6px;text-align:left;background:#f5f5f5">Document</th>
    <th style="border:1px solid #ccc;padding:6px;width:28px;background:#f5f5f5;font-size:10px;text-align:center">DA</th>
    <th style="border:1px solid #ccc;padding:4px;width:28px;background:#f5f5f5;font-size:10px;text-align:center">NU</th>
    <th style="border:1px solid #ccc;padding:4px;width:28px;background:#f5f5f5;font-size:10px;text-align:center">N/A</th>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Instrucțiuni de instalare, montare, reglare, utilizare și întreținere furnizate de producător</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_instructions_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_instructions_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_instructions_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Declarație de conformitate pentru instalare / montare / reparare aparat</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_conformity_declaration_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_conformity_declaration_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_conformity_declaration_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Schemă termomecanică</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_thermo_mechanical_schema_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_thermo_mechanical_schema_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_thermo_mechanical_schema_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Documentație de reparare</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_repair_documentation_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_repair_documentation_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_repair_documentation_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Aviz de combustibil</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_fuel_notice_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_fuel_notice_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{doc_fuel_notice_na}}</td>
  </tr>
</table>

<h2>IV. VERIFICAREA LUCRĂRILOR EFECTUATE</h2>
<table>
  <tr>
    <th style="border:1px solid #ccc;padding:6px;text-align:left;background:#f5f5f5">Verificare</th>
    <th style="border:1px solid #ccc;padding:6px;width:28px;background:#f5f5f5;font-size:10px;text-align:center">DA</th>
    <th style="border:1px solid #ccc;padding:4px;width:28px;background:#f5f5f5;font-size:10px;text-align:center">NU</th>
    <th style="border:1px solid #ccc;padding:4px;width:28px;background:#f5f5f5;font-size:10px;text-align:center">N/A</th>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Aparatul este instalat / montat conform instrucțiunilor de instalare / montare</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_installed_correct_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_installed_correct_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_installed_correct_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Aparatul este reparat conform documentației de reparare</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_repaired_correct_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_repaired_correct_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_repaired_correct_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Racord gaze</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_gas_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_gas_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_gas_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Racord electricitate</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_electricity_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_electricity_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_electricity_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Racord apă</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_water_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_water_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_connection_water_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Coș de fum evacuare gaze arse</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_flue_gas_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_flue_gas_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_flue_gas_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Tipul de combustibil disponibil este corespunzător categoriei aparatului</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_fuel_match_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_fuel_match_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_fuel_match_na}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Asigurarea aerului de ardere prin priza de aer / tubulatura aer</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_combustion_air_da}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_combustion_air_nu}}</td>
    <td style="border:1px solid #ccc;padding:3px;text-align:center;font-size:10px">{{work_combustion_air_na}}</td>
  </tr>
</table>

<h2>V. VERIFICĂRI FUNCȚIONALE</h2>

<h3>V.1 Verificări la rece</h3>
<table>
  <tr>
    <th style="border:1px solid #ccc;padding:6px;text-align:left;background:#f5f5f5">Verificare</th>
    <th style="border:1px solid #ccc;padding:6px;width:50px;background:#f5f5f5">DA</th>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Verificare etanșeitate circuit combustibil (presiune statică {{verif_fuel_static_pressure}} mbar)</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_fuel_sealing}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Verificare etanșeitate circuit apă (presiune {{verif_water_pressure_test}} bar, timp {{verif_water_pressure_time}} min)</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_water_sealing}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Verificare instalație electrică — tensiune {{verif_electrical_voltage}} V</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">X</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Verificarea legării la pământ</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_grounding}}</td>
  </tr>
</table>

<h3>V.2 Reglat sarcină aparat: {{verif_load_setting}} %</h3>

<h3>V.3 Verificări la cald</h3>
<p><strong>Tiraj:</strong> {{verif_draft_type}} — {{verif_draft_value}} mbar</p>
<table>
  <tr>
    <th style="border:1px solid #ccc;padding:6px;text-align:left;background:#f5f5f5">Parametru</th>
    <th style="border:1px solid #ccc;padding:6px;background:#f5f5f5">Valoare</th>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Presiunea gazului la intrare pe rampa de gaz (mbar)</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_gas_pressure_ramp}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Presiunea gazului la intrarea în arzător (mbar)</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_gas_pressure_burner}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Presiunea gazului la intrare în focar (mbar)</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_gas_pressure_focus}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Temperatura gazelor arse (°C)</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_t_gaz}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Verificarea etanșeității circuitului de gaze arse</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_flue_gas_sealing}}</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px">Verificarea funcțiilor de protecție aparat și instalații anexe</td>
    <td style="border:1px solid #ccc;padding:6px;text-align:center">{{verif_protection_functions}}</td>
  </tr>
</table>

<p><strong>Presiunea agentului termic:</strong> Apă {{verif_water_pressure}} bar</p>
<p><strong>Temperatura agentului termic:</strong> Apă tur/retur {{verif_water_temp_flow}} °C</p>
<p><strong>Valori limită confort:</strong> {{verif_comfort_limits}}</p>

<h3>Analiza gazelor arse</h3>
<p><strong>Analizor:</strong> {{analyzer_name}} — Seria: {{analyzer_serial}}</p>
<table>
  <tr>
    <th style="border:1px solid #ccc;padding:6px;text-align:left;background:#f5f5f5">Parametru</th>
    <th style="border:1px solid #ccc;padding:6px;background:#f5f5f5">Valoare măsurată</th>
  </tr>
  <tr><td style="border:1px solid #ccc;padding:6px">T gaz</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_t_gaz}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">T aer</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_t_aer}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">O₂ măsurat (%)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_o2}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">CO₂ (%)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_co2}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">CO măsurat (ppm)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_co}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">Randament combustie (Ec %)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_ec}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">Lambda (λ)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_lambda}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">Exces aer (%)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_excess_air}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">ΔT</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_delta_t}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">Pierderi gaze arse (Qs %)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_qs}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">Eficiență ardere (Es %)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_es}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">Eficiență totală (Et %)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_et}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">NO (ppm)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_no}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">NOx (ppm)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_nox}}</td></tr>
  <tr><td style="border:1px solid #ccc;padding:6px">PI (indice poluare)</td><td style="border:1px solid #ccc;padding:6px;text-align:center">{{readings_pi}}</td></tr>
</table>

<p style="font-size:11px;font-style:italic">*) Se precizează norma aplicabilă</p>
<p style="font-size:11px;font-style:italic">**) Se anexează buletinul de analiză a gazelor arse</p>

<h2>VI. CONCLUZII</h2>
<p>Aparatul îndeplinește / nu îndeplinește condițiile de funcționare, conform prevederilor prescripției tehnice A1/2010:</p>
<table>
  <tr>
    <td style="border:1px solid #ccc;padding:6px;width:40px;text-align:center;font-size:16px">[ {{decision_admis}} ]</td>
    <td style="border:1px solid #ccc;padding:6px"><strong>ADMIS</strong> — aparatul poate funcționa până la scadența următoarei verificări, cu obligația respectării instrucțiunilor de instalare, reglare, utilizare și întreținere date de producător și a prevederilor prescripției tehnice A1</td>
  </tr>
  <tr>
    <td style="border:1px solid #ccc;padding:6px;text-align:center;font-size:16px">[ {{decision_respins}} ]</td>
    <td style="border:1px solid #ccc;padding:6px"><strong>RESPINS</strong> — aparatul nu îndeplinește condițiile de punere în funcțiune și se interzice funcționarea acestuia</td>
  </tr>
</table>

<p><strong>SCADENȚA următoarei verificări:</strong> {{next_revision_date}}</p>

<p><strong>Numele și prenumele RSL:</strong> {{operator_name}}</p>
<p><strong>Numele și prenumele utilizatorului:</strong> {{client_name}}</p>
<p><strong>Numele și prenumele personalului instruit:</strong> {{client_name}}</p>
<p><strong>Am fost instruit (semnătura):</strong> ___________________</p>

<p><strong>Observații:</strong> {{observations}}</p>

<hr>

<h3>SEMNĂTURI</h3>
<table class="no-border">
  <tr>
    <td style="width:50%;padding:12px;vertical-align:top">
      <p><strong>Persoana juridică autorizată</strong></p>
      <p>{{tenant_name}}</p>
      <p>{{tenant_admin_name}}</p>
      <p>{{tenant_stamp}}</p>
      <p>{{tenant_signature}}</p>
    </td>
    <td style="width:50%;padding:12px;vertical-align:top">
      <p><strong>Deținător / Utilizator</strong></p>
      <p>{{client_name}}</p>
      <p>Semnătura: {{client_signature}}</p>
    </td>
  </tr>
</table>

<hr>

<p style="font-size:10px"><strong>Note:</strong></p>
<ol style="font-size:10px">
  <li>Orice înregistrare negativă duce la sistarea procedurii de punere în funcțiune a aparatului până la remedierea neconformității.</li>
  <li>Orice schimbare a amplasamentului aparatului necesită o nouă verificare.</li>
  <li>Prezentul formular se emite în 2 (două) exemplare/aparat, un exemplar pentru deținătorul / utilizatorul aparatului și un exemplar pentru persoana juridică autorizată.</li>
</ol>

<p style="font-size:10px;text-align:center">{{tenant_name}} — {{tenant_address}}, {{tenant_city}}, {{tenant_county}} | Tel: {{tenant_phone}}</p>`;

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
      description: "Raport oficial conform prescripției tehnice A1/2010 — structură XLSX cu date din PDF + observații tehnician",
      content: TEMPLATE_HTML,
    },
  });

  console.log(`Updated template: ${template.id}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
