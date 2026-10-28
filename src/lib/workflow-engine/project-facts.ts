/**
 * Proiectul, așa cum îl văd condițiile tranzițiilor (`project.*`). Pe lângă coloane,
 * codurile tipului și distribuitorului: un workflow general (de sistem) compară
 * `project.distributorCode == "DISTRIGAZ"`, nu id-ul distribuitorului unei firme.
 */
export function projectFacts(row: Record<string, unknown> & {
  distributor?: { code: string } | null;
  projectType?: { code: string } | null;
}): Record<string, unknown> {
  const { distributor, projectType, ...rest } = row;
  return { ...rest, distributorCode: distributor?.code ?? null, projectTypeCode: projectType?.code ?? null };
}
