export interface AliasTable {
  pokemon: Record<string, string[]>;
  moves: Record<string, string[]>;
  abilities: Record<string, string[]>;
  items: Record<string, string[]>;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[・\s._'-]/g, "");
}

export function buildAliasIndex(aliases: AliasTable): Map<string, string> {
  const index = new Map<string, string>();
  const categories: Array<Record<string, string[]>> = [
    aliases.pokemon,
    aliases.moves,
    aliases.abilities,
    aliases.items
  ];
  for (const category of categories) {
    for (const [id, values] of Object.entries(category)) {
      index.set(normalizeName(id), id);
      for (const value of values) {
        index.set(normalizeName(value), id);
      }
    }
  }
  return index;
}

export function lookupAlias(index: Map<string, string>, value: string): string | null {
  return index.get(normalizeName(value)) ?? null;
}
