import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "data", "champions");

const sourceUrl = "https://damekei.com/moves";

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

async function main() {
  const indexHtml = await fetchText(sourceUrl);
  const assetPath = indexHtml.match(/\/assets\/moves-[^"']+\.js/)?.[0];
  if (!assetPath) {
    throw new Error("Could not find damekei moves asset");
  }

  const assetUrl = new URL(assetPath, sourceUrl).toString();
  const code = await fetchText(assetUrl);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const module = (await import(moduleUrl)) as {
    m?: Array<{ id: number; name: { ja: string; en: string } }>;
  };
  const rows = module.m ?? [];
  if (rows.length < 900) {
    throw new Error(`Unexpectedly low damekei move count: ${rows.length}`);
  }

  const dex = Dex.forGen(9);
  const moves: Record<string, string[]> = {};
  const unresolved: Array<{ id: number; ja: string; en: string }> = [];

  for (const row of rows) {
    const move = dex.moves.get(row.name.en);
    if (!move.exists) {
      unresolved.push({ id: row.id, ja: row.name.ja, en: row.name.en });
      continue;
    }
    moves[move.id] ??= [];
    if (!moves[move.id].includes(row.name.ja)) {
      moves[move.id].push(row.name.ja);
    }
  }

  const output = {
    source: {
      name: "damekei",
      url: sourceUrl,
      assetUrl,
      fetchedAt: new Date().toISOString(),
      note: "Used for Japanese move-name aliases; unresolved Shadow moves are not part of @pkmn/dex Gen 9."
    },
    counts: {
      rows: rows.length,
      resolvedMoves: Object.keys(moves).length,
      aliases: Object.values(moves).reduce((sum, aliases) => sum + aliases.length, 0),
      unresolved: unresolved.length
    },
    moves,
    unresolved
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "move-ja-aliases.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Imported ${output.counts.aliases} Japanese move aliases for ${output.counts.resolvedMoves} moves`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
