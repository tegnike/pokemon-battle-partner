import assert from "node:assert/strict";
import path from "node:path";
import { createInitialBattleState } from "../src/domain.ts";
import { buildLocalKnowledge, speedComparisonCandidate, speedComparisonSpeech } from "../src/mastra/battleWorkflow.ts";
import { createLocalDataStore } from "../src/mastra/localData.ts";

const store = createLocalDataStore(path.resolve("data/champions"));
const state = createInitialBattleState("ササミ");

const opponentNames = ["ゲンガー", "ガブリアス", "ユキメノコ", "ペリッパー", "ブリジュラス", "ラグラージ"];
state.opponentTeam = state.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: opponentNames[index] ?? pokemon.name
}));
state.ownTeam = state.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: pokemon.name === "アシレーヌ" || pokemon.name === "ウォッシュロトム" || pokemon.name === "マスカーニャ"
}));

const candidate = speedComparisonCandidate(
  store,
  state,
  "なるほど、ありがとうございます。マスカーニャはゲンガーよりも遅いですか?"
);

assert.ok(candidate, "expected a deterministic speed comparison candidate");
assert.equal(candidate.kind, "note");
assert.match(candidate.command, /いいえ、マスカーニャの方が速いです。/);
assert.match(candidate.reason, /マスカーニャはS192/);
assert.match(candidate.reason, /ゲンガーは最速想定でS178/);
assert.match(
  speedComparisonSpeech(candidate),
  /マスターのマスカーニャの素早さは192ですが、ゲンガーは最速でも178なので、マスカーニャのほうが速いです。/
);
assert.match(speedComparisonSpeech(candidate), /メガゲンガーは最速200なので、メガ後は上を取られます。/);
assert.match(speedComparisonSpeech(candidate), /追い風や相手の素早さ上昇は確認されていません。/);

const megaState = {
  ...state,
  opponentTeam: state.opponentTeam.map((pokemon) =>
    pokemon.name === "ゲンガー" ? { ...pokemon, name: "メガゲンガー" } : pokemon
  )
};
const megaCandidate = speedComparisonCandidate(
  store,
  megaState,
  "なるほど、ありがとうございます。マスカーニャはメガゲンガーよりも遅いですか?"
);

assert.ok(megaCandidate, "expected a deterministic Mega Gengar speed comparison candidate");
assert.match(megaCandidate.command, /はい、マスカーニャの方が遅いです。/);
assert.match(speedComparisonSpeech(megaCandidate), /メガゲンガーは最速で200まで上がるので、マスカーニャのほうが遅いです。/);

const knowledge = buildLocalKnowledge(
  store,
  state,
  {
    opponentMentionedPokemon: ["ゲンガー"],
    opponentSelectedPokemon: [],
    ownMentionedPokemon: ["マスカーニャ"],
    ownSelectedPokemon: [],
    hpUpdates: [],
    faintedPokemon: [],
    statuses: [],
    revealedMoves: [],
    revealedAbility: [],
    revealedItem: [],
    damageCalcRequests: [],
    notes: []
  },
  path.resolve("data/champions")
);

assert.match(knowledge, /マスカーニャ: baseSpe=123; maxUnboostedSpeed=192; ownKnownSpeed=192/);
assert.match(knowledge, /ゲンガー: baseSpe=110; maxUnboostedSpeed=178/);

console.log("Validated speed comparison guard.");
