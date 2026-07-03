import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data", "champions");

const metadata = JSON.parse(fs.readFileSync(path.join(dataDir, "metadata.json"), "utf8"));
const moves = JSON.parse(fs.readFileSync(path.join(dataDir, "moves.json"), "utf8"));
const availability = JSON.parse(fs.readFileSync(path.join(dataDir, "move-availability.json"), "utf8"));
const aliases = JSON.parse(fs.readFileSync(path.join(dataDir, "ja-aliases.json"), "utf8"));
const moveJaAliases = JSON.parse(fs.readFileSync(path.join(dataDir, "move-ja-aliases.json"), "utf8"));

const byId = new Map(moves.map((move) => [move.id, move]));

assert.ok(availability.counts.uniqueMoves >= 900, "Champions availability import should cover the move table");
assert.ok(moveJaAliases.counts.resolvedMoves >= 900, "Japanese move aliases should cover known move names");
assert.equal(
  metadata.counts.championsUsableMoves +
    metadata.counts.championsUnusableMoves +
    metadata.counts.championsUnknownMoves,
  metadata.counts.moves
);
assert.ok(metadata.counts.championsUsableMoves >= availability.counts.usable);
assert.equal(byId.get("earthquake").usableInChampions, true);
assert.equal(byId.get("pound").usableInChampions, false);
assert.equal(byId.get("gmaxwildfire").usableInChampions, null);
assert.equal(byId.get("icywind").secondary.boosts.spe, -1);
assert.ok(aliases.moves.earthquake.includes("じしん"));
assert.ok(aliases.moves.icywind.includes("こごえるかぜ"));
assert.ok(aliases.moves.closecombat.includes("インファイト"));

console.log("champions-data tests passed");
