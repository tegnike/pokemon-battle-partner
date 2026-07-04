import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "data", "champions");

const sourceBaseUrl = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv";
const speciesUrl = `${sourceBaseUrl}/pokemon_species.csv`;
const speciesNamesUrl = `${sourceBaseUrl}/pokemon_species_names.csv`;

function toId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "pokemon-battle-partner-data-import/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0] ?? "");
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

async function main() {
  const [speciesCsv, speciesNamesCsv] = await Promise.all([fetchText(speciesUrl), fetchText(speciesNamesUrl)]);
  const speciesRows = parseCsv(speciesCsv);
  const nameRows = parseCsv(speciesNamesCsv);

  const speciesIdToDexId = new Map<string, string>();
  for (const row of speciesRows) {
    speciesIdToDexId.set(row.id, toId(row.identifier));
  }

  const pokemon: Record<string, string[]> = {};
  const unresolved: Array<{ pokemonSpeciesId: string; name: string; dexId: string | null }> = [];
  const dex = Dex.forGen(9);

  for (const row of nameRows) {
    if (row.local_language_id !== "1") continue;
    const dexId = speciesIdToDexId.get(row.pokemon_species_id) ?? null;
    if (!dexId) {
      unresolved.push({ pokemonSpeciesId: row.pokemon_species_id, name: row.name, dexId });
      continue;
    }
    const species = dex.species.get(dexId);
    if (!species.exists) {
      unresolved.push({ pokemonSpeciesId: row.pokemon_species_id, name: row.name, dexId });
      continue;
    }
    pokemon[species.id] ??= [];
    if (!pokemon[species.id].includes(row.name)) {
      pokemon[species.id].push(row.name);
    }
  }

  const output = {
    source: {
      name: "PokeAPI",
      speciesUrl,
      speciesNamesUrl,
      fetchedAt: new Date().toISOString(),
      note: "Used for Japanese Pokemon species-name aliases. Form-specific aliases are supplemented by manual aliases."
    },
    counts: {
      speciesRows: speciesRows.length,
      nameRows: nameRows.length,
      resolvedPokemon: Object.keys(pokemon).length,
      aliases: Object.values(pokemon).reduce((sum, aliases) => sum + aliases.length, 0),
      unresolved: unresolved.length
    },
    pokemon,
    unresolved
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "pokemon-ja-aliases.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Imported ${output.counts.aliases} Japanese Pokemon aliases for ${output.counts.resolvedPokemon} species`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
