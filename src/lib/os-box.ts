/**
 * Caseta „Înregistrat la / Nr. înregistrare” de pe documentele care se depun la
 * distribuitor (fișele RT/FISA, raportul ISCIR al reviziei de centrală): operatorul
 * de sistem și numărul primit de la el. Până la înregistrare rămân linii de completat.
 */
const BLANK = "______________";

export function osBoxData(
  appt: {
    osRegistrationNumber: string | null;
    osRegisteredAt: Date | null;
    installation?: { distributorName: string | null } | null;
  } | null,
  companyOperatorSistem: string,
): { os_denumire: string; os_nr_inregistrare: string; os_data_inregistrare: string } {
  return {
    os_denumire: appt?.installation?.distributorName?.trim() || companyOperatorSistem.trim() || BLANK,
    os_nr_inregistrare: appt?.osRegistrationNumber || BLANK,
    os_data_inregistrare: appt?.osRegisteredAt ? appt.osRegisteredAt.toLocaleDateString("ro-RO") : BLANK,
  };
}
