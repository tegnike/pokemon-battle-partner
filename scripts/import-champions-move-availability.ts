import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Dex } from "@pkmn/dex";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.join(projectRoot, "data", "champions");

const pageTitle = "List_of_moves_by_availability_in_Pokémon_Champions";
const sourceUrl = `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(pageTitle)}`;
const rawUrl = `https://bulbapedia.bulbagarden.net/w/index.php?title=${encodeURIComponent(pageTitle)}&action=raw`;
const apiUrl =
  `https://bulbapedia.bulbagarden.net/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(
    pageTitle
  )}&rvprop=ids|timestamp&format=json`;

interface RevisionInfo {
  revisionId: number | null;
  revisionTimestamp: string | null;
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

async function fetchRevisionInfo(): Promise<RevisionInfo> {
  try {
    const json = JSON.parse(await fetchText(apiUrl)) as {
      query?: { pages?: Record<string, { revisions?: Array<{ revid?: number; timestamp?: string }> }> };
    };
    const page = Object.values(json.query?.pages ?? {})[0];
    const revision = page?.revisions?.[0];
    return {
      revisionId: revision?.revid ?? null,
      revisionTimestamp: revision?.timestamp ?? null
    };
  } catch {
    return {
      revisionId: null,
      revisionTimestamp: null
    };
  }
}

async function main() {
  const raw = await fetchText(rawUrl);
  const revision = await fetchRevisionInfo();
  const dex = Dex.forGen(9);
  const rowPattern =
    /\|-\n\|\s*(\d+)\n\|\s*\{\{m\|([^}]+)\}\}[\s\S]*?\|\s*\{\{(yes|no)\}\}/g;
  const moves: Record<string, boolean> = {};
  const entries: Array<{ num: number; id: string; name: string; usable: boolean }> = [];
  const unresolved: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = rowPattern.exec(raw))) {
    const [, numText, name, availability] = match;
    const move = dex.moves.get(name);
    if (!move.exists) {
      unresolved.push(name);
      continue;
    }
    const usable = availability === "yes";
    if (moves[move.id] !== undefined && moves[move.id] !== usable) {
      throw new Error(`Conflicting availability for ${move.id}`);
    }
    moves[move.id] = usable;
    entries.push({ num: Number(numText), id: move.id, name: move.name, usable });
  }

  if (unresolved.length > 0) {
    throw new Error(`Unresolved moves: ${unresolved.join(", ")}`);
  }
  if (entries.length < 900) {
    throw new Error(`Unexpectedly low move availability count: ${entries.length}`);
  }

  const output = {
    source: {
      name: "Bulbapedia",
      url: sourceUrl,
      rawUrl,
      pageTitle,
      revisionId: revision.revisionId,
      revisionTimestamp: revision.revisionTimestamp,
      fetchedAt: new Date().toISOString(),
      note: "Bulbapedia marks currently usable Pokemon Champions moves with yes/no availability."
    },
    counts: {
      rows: entries.length,
      uniqueMoves: Object.keys(moves).length,
      usable: Object.values(moves).filter(Boolean).length,
      unusable: Object.values(moves).filter((usable) => !usable).length
    },
    moves
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "move-availability.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Imported ${output.counts.uniqueMoves} Champions move availability entries (${output.counts.usable} usable)`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
