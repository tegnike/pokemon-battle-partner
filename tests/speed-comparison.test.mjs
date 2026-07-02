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

const raichuState = {
  ...state,
  opponentTeam: state.opponentTeam.map((pokemon, index) => ({
    ...pokemon,
    name: index === 0 ? "ライチュウ" : pokemon.name
  }))
};
const raichuCandidate = speedComparisonCandidate(
  store,
  raichuState,
  "マスカーニャはライチュウよりも速いですか?"
);

assert.ok(raichuCandidate, "expected a deterministic Raichu speed comparison candidate");
assert.match(speedComparisonSpeech(raichuCandidate), /メガライチュウYは最速200なので、メガ後は上を取られます。/);
assert.match(speedComparisonSpeech(raichuCandidate), /メガライチュウXは最速178なので、現在条件ではマスカーニャが上です。/);

const tailwindState = {
  ...state,
  field: "相手側に追い風"
};
const tailwindCandidate = speedComparisonCandidate(
  store,
  tailwindState,
  "なるほど、ありがとうございます。マスカーニャはゲンガーよりも遅いですか?"
);

assert.ok(tailwindCandidate, "expected tailwind to affect speed comparison");
assert.match(speedComparisonSpeech(tailwindCandidate), /ゲンガーは実効356/);
assert.match(speedComparisonSpeech(tailwindCandidate), /マスカーニャのほうが遅いです。/);

const boostedState = {
  ...state,
  opponentTeam: state.opponentTeam.map((pokemon) =>
    pokemon.name === "ゲンガー" ? { ...pokemon, statChanges: "素早さ+1" } : pokemon
  )
};
const boostedCandidate = speedComparisonCandidate(
  store,
  boostedState,
  "なるほど、ありがとうございます。マスカーニャはゲンガーよりも遅いですか?"
);

assert.ok(boostedCandidate, "expected speed stage to affect speed comparison");
assert.match(speedComparisonSpeech(boostedCandidate), /ゲンガーは実効267/);
assert.match(speedComparisonSpeech(boostedCandidate), /ゲンガーの能力変化メモは「素早さ\+1」です。/);

const charizardState = {
  ...state,
  opponentTeam: state.opponentTeam.map((pokemon, index) => ({
    ...pokemon,
    name: index === 0 ? "リザードン" : pokemon.name
  }))
};
const megaCharizardCandidate = speedComparisonCandidate(
  store,
  charizardState,
  "マスカーニャはメガリザードンYよりも速いですか?"
);

assert.ok(megaCharizardCandidate, "expected explicit Mega Charizard Y to resolve");
assert.match(speedComparisonSpeech(megaCharizardCandidate), /メガリザードンYは最速でも167/);
assert.match(speedComparisonSpeech(megaCharizardCandidate), /マスカーニャのほうが速いです。/);

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
    statChanges: [],
    damageCalcRequests: [],
    notes: []
  },
  path.resolve("data/champions")
);

assert.match(knowledge, /マスカーニャ: baseSpe=123; maxUnboostedSpeed=192; ownKnownSpeed=192/);
assert.match(knowledge, /ゲンガー: baseSpe=110; maxUnboostedSpeed=178/);

console.log("Validated speed comparison guard.");
