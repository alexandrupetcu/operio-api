/**
 * Funcțiile unui angajat. La firmele mici același om e și instalator, și șef de șantier,
 * și RTE: `positions` le ține pe toate, iar `position` rămâne prima (funcția principală),
 * pentru ecranele și aplicația mobilă care citesc un singur câmp.
 */
export function withPositions<T extends { position?: string | null; positions?: string[] }>(input: T): T {
  if (input.positions !== undefined) {
    const positions = [...new Set(input.positions.map((p) => p.trim()).filter(Boolean))];
    return { ...input, positions, position: positions[0] ?? null };
  }
  if (input.position !== undefined) return { ...input, positions: input.position ? [input.position] : [] };
  return input;
}
