/**
 * Cache în memorie cu expirare, pentru valori citite la fiecare cerere dar schimbate rar
 * (setările de programare ale firmei, legătura cont↔angajat). Ceasul e injectabil ca să
 * fie testabil fără timere.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; exp: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.exp <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): V {
    this.entries.set(key, { value, exp: this.now() + this.ttlMs });
    return value;
  }

  /** Valoarea din cache sau cea calculată de `load` (și pusă în cache). */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, await load());
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
