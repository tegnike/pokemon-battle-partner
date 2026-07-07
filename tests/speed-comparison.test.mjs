import assert from "node:assert/strict";
import path from "node:path";
import { createInitialBattleState } from "../src/domain.ts";
import {
  applyFactsToState,
  applyKnownMoveSideEffectFacts,
  buildLocalKnowledge,
  inferOpponentPartyPokemonFromText,
  localActiveMoveCandidates,
  isExecutionAcknowledgement,
  isPositiveFeedback,
  localReplacementCandidates,
  localSwitchCandidate,
  repairInvalidBattleAdvice,
  sanitizeBattleCandidates,
  sanitizeSpeechForVoice,
  speedComparisonCandidate,
  speedComparisonSpeech
} from "../src/mastra/battleWorkflow.ts";
import { createLocalDataStore } from "../src/mastra/localData.ts";

const store = createLocalDataStore(path.resolve("data/champions"));
const state = createInitialBattleState("ササミ");

function emptyFacts(overrides = {}) {
  return {
    opponentMentionedPokemon: [],
    opponentSelectedPokemon: [],
    ownMentionedPokemon: [],
    ownSelectedPokemon: [],
    hpUpdates: [],
    faintedPokemon: [],
    statuses: [],
    revealedMoves: [],
    revealedAbility: [],
    revealedItem: [],
    statChanges: [],
    damageCalcRequests: [],
    notes: [],
    ...overrides
  };
}

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

const garchompSpeedDropState = createInitialBattleState("ササミ");
garchompSpeedDropState.phase = "battle";
garchompSpeedDropState.activeOwn = "ガブリアス";
garchompSpeedDropState.activeOpponent = "ゲンガー";
garchompSpeedDropState.opponentTeam = garchompSpeedDropState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "ゲンガー" : pokemon.name,
  selected: index === 0,
  active: index === 0
}));

const icyWindFacts = applyKnownMoveSideEffectFacts(
  {
    opponentMentionedPokemon: [],
    opponentSelectedPokemon: [],
    ownMentionedPokemon: [],
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
  "ゲンガーの凍える風でガブリアスのHPが20まで減らされてしまいました。",
  garchompSpeedDropState,
  store
);
assert.deepEqual(icyWindFacts.statChanges, [{ side: "own", pokemon: "ガブリアス", changes: "素早さ-1" }]);
assert.deepEqual(icyWindFacts.revealedMoves, [{ pokemon: "ゲンガー", move: "こごえるかぜ", certainty: "confirmed" }]);

const rockTombFacts = applyKnownMoveSideEffectFacts(
  {
    opponentMentionedPokemon: [],
    opponentSelectedPokemon: [],
    ownMentionedPokemon: [],
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
  "こちらのガブリアスのがんせきふうじがゲンガーに入りました。",
  garchompSpeedDropState,
  store
);
assert.deepEqual(rockTombFacts.statChanges, [{ side: "opponent", pokemon: "ゲンガー", changes: "素早さ-1" }]);

const leafStormState = {
  ...garchompSpeedDropState,
  activeOwn: "マスカーニャ",
  ownTeam: garchompSpeedDropState.ownTeam.map((pokemon) => ({
    ...pokemon,
    active: pokemon.name === "マスカーニャ"
  }))
};
const leafStormFacts = applyKnownMoveSideEffectFacts(
  {
    opponentMentionedPokemon: [],
    opponentSelectedPokemon: [],
    ownMentionedPokemon: [],
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
  "こちらのマスカーニャのリーフストームを使いました。",
  leafStormState,
  store
);
assert.deepEqual(leafStormFacts.statChanges, [{ side: "own", pokemon: "マスカーニャ", changes: "特攻-2" }]);

const loweredGarchompState = {
  ...garchompSpeedDropState,
  ownTeam: garchompSpeedDropState.ownTeam.map((pokemon) =>
    pokemon.name === "ガブリアス" ? { ...pokemon, statChanges: "素早さ-1" } : pokemon
  )
};
const loweredGarchompCandidate = speedComparisonCandidate(
  store,
  loweredGarchompState,
  "ガブリアスはゲンガーより速いですか?"
);
assert.ok(loweredGarchompCandidate, "expected own speed drop to affect speed comparison");
assert.match(loweredGarchompCandidate.reason, /ガブリアスはS169（実効S112）/);
assert.match(speedComparisonSpeech(loweredGarchompCandidate), /ガブリアスは実効112/);
assert.match(speedComparisonSpeech(loweredGarchompCandidate), /ガブリアスのほうが遅いです。/);

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

const switchState = createInitialBattleState("ササミ");
switchState.phase = "battle";
switchState.status = "active";
switchState.activeOwn = "ガブリアス";
switchState.activeOpponent = "ラグラージ";
switchState.opponentTeam = switchState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "ラグラージ" : pokemon.name,
  selected: index === 0,
  active: index === 0
}));
switchState.ownTeam = switchState.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: ["ガブリアス", "アシレーヌ", "ウォッシュロトム"].includes(pokemon.name),
  active: pokemon.name === "ガブリアス",
  hpPercent: pokemon.name === "ガブリアス" ? 35 : pokemon.hpPercent
}));

const switchCandidate = localSwitchCandidate(store, switchState);
assert.ok(switchCandidate, "expected a deterministic local switch candidate");
assert.equal(switchCandidate.kind, "switch");
assert.notEqual(switchCandidate.command, "ガブリアス");
assert.ok(["アシレーヌ", "ウォッシュロトム"].includes(switchCandidate.command));
assert.equal(switchCandidate.confidence, "low");
assert.match(switchCandidate.reason, /最終判断AIが比較するための交代材料/);

assert.equal(isExecutionAcknowledgement("わかりました。地震でいきます。"), true);
assert.equal(isExecutionAcknowledgement("なるほど、では岩石封じをします。次のターンちょっと待っててください。"), true);
assert.equal(isExecutionAcknowledgement("ガブリアスは何をすればいいでしょうか?"), false);
assert.equal(isExecutionAcknowledgement("地震でいっていいですか?"), false);
assert.equal(
  isExecutionAcknowledgement("わかりました。ではメタグロスを出します。メガ進化して何か技を選択するってことですかね。"),
  false
);
assert.equal(isPositiveFeedback("なるほど、いいと思います。"), true);
assert.equal(isPositiveFeedback("良いと思います。"), true);
assert.equal(isPositiveFeedback("いいと思いますが、次は何をすればいいですか?"), false);
assert.deepEqual(
  inferOpponentPartyPokemonFromText(
    store,
    "相手のポケモンはゲンガー、ガブリアス、ミミッキュ、ブリジュラス、ペリッパー、マスカーニャの6体です。"
  ),
  ["ゲンガー", "ガブリアス", "ミミッキュ", "ブリジュラス", "ペリッパー", "マスカーニャ"]
);

const ceruledgeState = createInitialBattleState("ルフィ");
ceruledgeState.phase = "battle";
ceruledgeState.status = "active";
ceruledgeState.activeOwn = "メタグロス";
ceruledgeState.activeOpponent = "ソウブレイズ";
ceruledgeState.ownTeam = ceruledgeState.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: ["ガブリアス", "アシレーヌ", "メタグロス"].includes(pokemon.name),
  active: pokemon.name === "メタグロス"
}));
ceruledgeState.opponentTeam = ceruledgeState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "ソウブレイズ" : pokemon.name,
  selected: index === 0,
  active: index === 0
}));

const metagrossMoves = localActiveMoveCandidates(store, ceruledgeState);
assert.equal(metagrossMoves[0]?.command, "じしん");
assert.equal(metagrossMoves[0]?.moveMatchup?.effectiveness, 2);
assert.equal(
  metagrossMoves.find((candidate) => candidate.command === "バレットパンチ")?.moveMatchup?.effectiveness,
  0.5
);
assert.equal(metagrossMoves[0]?.moveMatchup?.userMovesFirstBySpeed, true);

const primarinaVsCeruledgeState = {
  ...ceruledgeState,
  activeOwn: "アシレーヌ",
  ownTeam: ceruledgeState.ownTeam.map((pokemon) => ({
    ...pokemon,
    active: pokemon.name === "アシレーヌ"
  }))
};
const primarinaMoves = localActiveMoveCandidates(store, primarinaVsCeruledgeState);
assert.equal(primarinaMoves[0]?.command, "うたかたのアリア");
assert.equal(primarinaMoves[0]?.moveMatchup?.effectiveness, 2);
assert.equal(
  primarinaMoves.find((candidate) => candidate.command === "ムーンフォース")?.moveMatchup?.effectiveness,
  0.5
);

const sceptileState = createInitialBattleState("ヨン");
sceptileState.phase = "battle";
sceptileState.status = "active";
sceptileState.activeOwn = "ガブリアス";
sceptileState.activeOpponent = "ジュカイン";
sceptileState.ownTeam = sceptileState.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: ["ガブリアス", "アシレーヌ", "メタグロス"].includes(pokemon.name),
  active: pokemon.name === "ガブリアス"
}));
sceptileState.opponentTeam = sceptileState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "ジュカイン" : pokemon.name,
  selected: index === 0,
  active: index === 0
}));
const garchompVsSceptileMoves = localActiveMoveCandidates(store, sceptileState);
assert.equal(garchompVsSceptileMoves[0]?.command, "ドラゴンクロー");
assert.equal(
  garchompVsSceptileMoves.find((candidate) => candidate.command === "じしん")?.moveMatchup?.effectiveness,
  0.5
);

const vaporeonWallState = createInitialBattleState("ミカにゃん");
vaporeonWallState.phase = "battle";
vaporeonWallState.status = "active";
vaporeonWallState.activeOwn = "ガブリアス";
vaporeonWallState.activeOpponent = "シャワーズ";
vaporeonWallState.field = "相手側: リフレクター、相手側: ひかりのかべ";
vaporeonWallState.ownTeam = vaporeonWallState.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: ["ガブリアス", "アシレーヌ", "メタグロス"].includes(pokemon.name),
  active: pokemon.name === "ガブリアス",
  statChanges: pokemon.name === "ガブリアス" ? "こうげき-1 / とくこう-1" : pokemon.statChanges
}));
vaporeonWallState.opponentTeam = vaporeonWallState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "シャワーズ" : pokemon.name,
  selected: index === 0,
  active: index === 0,
  hpPercent: index === 0 ? 44 : pokemon.hpPercent
}));
const vaporeonWallMoves = localActiveMoveCandidates(store, vaporeonWallState);
const earthquakeVsVaporeon = vaporeonWallMoves.find((candidate) => candidate.command === "じしん");
assert.ok(earthquakeVsVaporeon, "expected earthquake candidate against Vaporeon");
assert.equal(earthquakeVsVaporeon.moveMatchup.percentMax, 24.9);
assert.match(earthquakeVsVaporeon.moveMatchup.note, /攻撃-1、相手側リフレクター込み/);

const preservedSelectionState = applyFactsToState(
  vaporeonWallState,
  emptyFacts({
    phase: "battle",
    ownSelectedPokemon: ["ガブリアス"],
    activeOwn: "ガブリアス",
    activeOpponent: "シャワーズ"
  }),
  store
);
assert.deepEqual(
  preservedSelectionState.ownTeam.filter((pokemon) => pokemon.selected).map((pokemon) => pokemon.name),
  ["ガブリアス", "アシレーヌ", "メタグロス"]
);

const preservedBattleSelectionAgainstThreeNames = applyFactsToState(
  vaporeonWallState,
  emptyFacts({
    phase: "battle",
    ownSelectedPokemon: ["アシレーヌ", "メタグロス", "サザンドラ"],
    activeOwn: "メタグロス",
    activeOpponent: "シャワーズ"
  }),
  store
);
assert.deepEqual(
  preservedBattleSelectionAgainstThreeNames.ownTeam.filter((pokemon) => pokemon.selected).map((pokemon) => pokemon.name),
  ["ガブリアス", "アシレーヌ", "メタグロス"]
);
assert.equal(preservedBattleSelectionAgainstThreeNames.activeOwn, "メタグロス");

const garchompMirrorState = createInitialBattleState("キラッチ");
garchompMirrorState.phase = "battle";
garchompMirrorState.status = "active";
garchompMirrorState.activeOwn = "アシレーヌ";
garchompMirrorState.activeOpponent = "ガブリアス";
garchompMirrorState.ownTeam = garchompMirrorState.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: ["ガブリアス", "アシレーヌ", "メタグロス"].includes(pokemon.name),
  active: pokemon.name === "アシレーヌ"
}));
garchompMirrorState.opponentTeam = garchompMirrorState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "ガブリアス" : pokemon.name,
  selected: index === 0,
  active: index === 0,
  hpPercent: index === 0 ? 100 : pokemon.hpPercent
}));
assert.equal(localSwitchCandidate(store, garchompMirrorState), null);

const yawnFacts = applyKnownMoveSideEffectFacts(
  emptyFacts(),
  "シャワーズはあくびをせんたく",
  vaporeonWallState,
  store
);
assert.deepEqual(yawnFacts.revealedMoves, [{ pokemon: "シャワーズ", move: "あくび", certainty: "confirmed" }]);
assert.deepEqual(yawnFacts.statuses, [{ side: "own", pokemon: "ガブリアス", condition: "あくび" }]);

const earthquakeHomophoneFacts = applyKnownMoveSideEffectFacts(
  emptyFacts({
    activeOwn: "ガブリアス",
    activeOpponent: "シャワーズ",
    hpUpdates: [{ side: "own", pokemon: "ガブリアス", hpPercent: 79 }]
  }),
  "リフレクターをされました。自身で79%まで削れました。",
  vaporeonWallState,
  store
);
assert.deepEqual(earthquakeHomophoneFacts.hpUpdates, [{ side: "opponent", pokemon: "シャワーズ", hpPercent: 79 }]);

const sanitizedSwitches = sanitizeBattleCandidates(primarinaVsCeruledgeState, [
  {
    kind: "switch",
    command: "ウォッシュロトム",
    reason: "未選出のため通してはいけない候補。",
    risk: "選出外。",
    confidence: "medium"
  },
  {
    kind: "switch",
    command: "メタグロス",
    reason: "選出済みの控えなので有効。",
    risk: "受け出し負荷。",
    confidence: "medium"
  }
]);
assert.equal(sanitizedSwitches.some((candidate) => candidate.command === "ウォッシュロトム"), false);
assert.equal(sanitizedSwitches.some((candidate) => candidate.command === "メタグロス"), true);

const megaStarmieTypoState = createInitialBattleState("あばたん");
megaStarmieTypoState.phase = "battle";
megaStarmieTypoState.status = "active";
megaStarmieTypoState.activeOwn = "メタグロス";
megaStarmieTypoState.activeOpponent = "メガスターミ";
megaStarmieTypoState.ownTeam = megaStarmieTypoState.ownTeam.map((pokemon) => ({
  ...pokemon,
  selected: ["ガブリアス", "アシレーヌ", "メタグロス"].includes(pokemon.name),
  active: pokemon.name === "メタグロス"
}));
megaStarmieTypoState.opponentTeam = megaStarmieTypoState.opponentTeam.map((pokemon, index) => ({
  ...pokemon,
  name: index === 0 ? "メガスターミ" : pokemon.name,
  selected: index === 0,
  active: index === 0,
  hpPercent: index === 0 ? 13 : pokemon.hpPercent
}));
const resolvedMegaStarmieState = applyFactsToState(
  megaStarmieTypoState,
  emptyFacts({
    phase: "battle",
    activeOwn: "メタグロス",
    activeOpponent: "メガスターミー",
    faintedPokemon: [{ side: "opponent", pokemon: "メガスターミー" }]
  }),
  store
);
assert.deepEqual(
  resolvedMegaStarmieState.opponentTeam.filter((pokemon) => pokemon.name.includes("スターミ")).map((pokemon) => pokemon.name),
  ["メガスターミー"]
);
assert.equal(resolvedMegaStarmieState.opponentTeam.find((pokemon) => pokemon.name === "メガスターミー")?.condition, "ひんし");
assert.equal(resolvedMegaStarmieState.activeOpponent, "");

const lowHpCeruledgeState = {
  ...ceruledgeState,
  opponentTeam: ceruledgeState.opponentTeam.map((pokemon) =>
    pokemon.name === "ソウブレイズ" ? { ...pokemon, hpPercent: 1 } : pokemon
  )
};
const lowHpMetagrossMoves = localActiveMoveCandidates(store, lowHpCeruledgeState);
assert.equal(lowHpMetagrossMoves[0]?.command, "バレットパンチ");
assert.equal(lowHpMetagrossMoves[0]?.moveMatchup?.priority, 1);

const mistakenSelectionAdvice = repairInvalidBattleAdvice(
  store,
  {
    updatedState: {
      ...primarinaVsCeruledgeState,
      phase: "selection",
      activeOwn: "ガブリアス",
      ownTeam: primarinaVsCeruledgeState.ownTeam.map((pokemon) => ({
        ...pokemon,
        selected: ["ガブリアス", "ウォッシュロトム", "サザンドラ"].includes(pokemon.name),
        active: pokemon.name === "ガブリアス"
      }))
    },
    action: {
      kind: "selection",
      command: "ガブリアス、ウォッシュロトム、サザンドラ",
      reason: "誤って選出をやり直している。",
      risk: "対戦中に選出へ戻ってしまう。",
      confidence: "medium"
    },
    speech: "ここはガブリアス、ウォッシュロトム、サザンドラでいきましょう。",
    memo: "誤った選出指示"
  },
  primarinaVsCeruledgeState,
  localActiveMoveCandidates(store, primarinaVsCeruledgeState)
);
assert.notEqual(mistakenSelectionAdvice.action.kind, "selection");
assert.equal(mistakenSelectionAdvice.updatedState.phase, "battle");
assert.deepEqual(
  mistakenSelectionAdvice.updatedState.ownTeam.filter((pokemon) => pokemon.selected).map((pokemon) => pokemon.name),
  ["ガブリアス", "アシレーヌ", "メタグロス"]
);
assert.equal(mistakenSelectionAdvice.updatedState.activeOwn, "アシレーヌ");
assert.equal(/先発|対戦よろしく|選出/.test(mistakenSelectionAdvice.speech), false);

const replacementNeededState = {
  ...primarinaVsCeruledgeState,
  activeOwn: "",
  ownTeam: primarinaVsCeruledgeState.ownTeam.map((pokemon) => ({
    ...pokemon,
    active: false,
    selected: ["ガブリアス", "アシレーヌ", "メタグロス"].includes(pokemon.name),
    condition: pokemon.name === "アシレーヌ" ? "ひんし" : pokemon.condition,
    hpPercent: pokemon.name === "アシレーヌ" ? 0 : pokemon.hpPercent
  }))
};
const replacementCandidates = localReplacementCandidates(replacementNeededState);
assert.deepEqual(replacementCandidates.map((candidate) => candidate.command), ["ガブリアス", "メタグロス"]);
const repairedReplacement = repairInvalidBattleAdvice(
  store,
  {
    updatedState: { ...replacementNeededState, phase: "selection" },
    action: {
      kind: "selection",
      command: "ガブリアス、ウォッシュロトム、サザンドラ",
      reason: "誤って3体を選び直している。",
      risk: "対戦中に選出へ戻ってしまう。",
      confidence: "medium"
    },
    speech: "ここはガブリアス、ウォッシュロトム、サザンドラでいきましょう。先発はガブリアスです。",
    memo: "誤った選出指示"
  },
  replacementNeededState,
  replacementCandidates
);
assert.equal(repairedReplacement.action.kind, "switch");
assert.equal(["ガブリアス", "メタグロス"].includes(repairedReplacement.action.command), true);
assert.equal(/先発|対戦よろしく|選出/.test(repairedReplacement.speech), false);

const selectionLikeSpeechAdvice = repairInvalidBattleAdvice(
  store,
  {
    updatedState: primarinaVsCeruledgeState,
    action: {
      kind: "move",
      command: "うたかたのアリア",
      reason: "ソウブレイズに水打点で押す。",
      risk: "交代される可能性があります。",
      confidence: "high"
    },
    speech: "ここはガブリアス、アシレーヌ、メタグロスでいきましょう。先発はガブリアスです。対戦よろしくお願いします。",
    memo: "セリフだけ選出文"
  },
  primarinaVsCeruledgeState,
  primarinaMoves
);
assert.equal(selectionLikeSpeechAdvice.action.kind, "move");
assert.equal(selectionLikeSpeechAdvice.speech.includes("うたかたのアリア"), true);
assert.equal(/先発|対戦よろしく|選出/.test(selectionLikeSpeechAdvice.speech), false);

const sanitizedSpeech = sanitizeSpeechForVoice(
  "ここはじしんです。概算203.7-240%入るので、相手HP13%なら確実に圏内です。"
);
assert.equal(sanitizedSpeech.includes("%"), false);
assert.match(sanitizedSpeech, /倒し切れる火力|圏内|削れた状態/);

console.log("Validated speed comparison guard.");
