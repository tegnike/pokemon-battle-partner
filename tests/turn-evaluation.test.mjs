// 両面ターン評価(turnEvaluation.ts)とガード緩和の回帰テスト。
// 守るもの:
// 1. 対戦中の候補に補助技(おにび・ステルスロック等)が構造的に入ること
// 2. 相手→自分方向の被弾見積もりが計算されること(特性による無効化を含む)
// 3. ガードが「候補プール外だが正当な技」を差し替えず、「無効(0倍)技」だけを差し替えること
import assert from "node:assert/strict";
import path from "node:path";
import { createInitialBattleState } from "../src/domain.ts";
import {
  applyFactsToState,
  localBattleCandidates,
  repairInvalidBattleAdvice
} from "../src/mastra/battleWorkflow.ts";
import {
  buildThreatReport,
  estimateIncomingThreats,
  estimateSwitchInRisks,
  summarizeThreatReport,
  utilityMoveCandidates
} from "../src/mastra/turnEvaluation.ts";
import { createLocalDataStore } from "../src/mastra/localData.ts";

const store = createLocalDataStore(path.resolve("data/champions"));

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

function battleState({ activeOwn, activeOpponent, extraFacts = {} }) {
  let state = createInitialBattleState("テスト");
  state = { ...state, phase: "battle", status: "active" };
  return applyFactsToState(
    state,
    emptyFacts({
      phase: "battle",
      ownSelectedPokemon: ["ガブリアス", "メタグロス", "ウォッシュロトム"],
      activeOwn,
      activeOpponent,
      ...extraFacts
    }),
    store
  );
}

// --- 1. 補助技が候補に入る -----------------------------------------------------

// ウォッシュロトム(おにび持ち) vs ミミッキュ(物理寄り)
{
  const state = battleState({ activeOwn: "ウォッシュロトム", activeOpponent: "ミミッキュ" });
  const utility = utilityMoveCandidates(store, state);
  assert.ok(
    utility.some((candidate) => candidate.command === "おにび"),
    `おにび should be a utility candidate: ${JSON.stringify(utility.map((c) => c.command))}`
  );
  const onibi = utility.find((candidate) => candidate.command === "おにび");
  assert.match(onibi.reason, /やけど/, "onibi reason should describe the burn effect");
  assert.match(onibi.reason, /物理寄り/, "onibi reason should flag the physical attacker");

  const candidates = localBattleCandidates(store, state);
  assert.ok(
    candidates.some((candidate) => candidate.command === "おにび"),
    `battle candidates must include おにび: ${JSON.stringify(candidates.map((c) => `${c.kind}:${c.command}`))}`
  );
  assert.ok(
    candidates.some((candidate) => candidate.kind === "move" && candidate.command !== "おにび"),
    "battle candidates must still include damage moves"
  );
}

// ガブリアス(ステルスロック持ち)は設置技が候補に入り、設置済みなら重ねない
{
  const state = battleState({ activeOwn: "ガブリアス", activeOpponent: "ミミッキュ" });
  const utility = utilityMoveCandidates(store, state);
  assert.ok(
    utility.some((candidate) => candidate.command === "ステルスロック"),
    `stealth rock should be a utility candidate: ${JSON.stringify(utility.map((c) => c.command))}`
  );

  const withRocks = { ...state, field: "相手側: ステルスロック" };
  const suppressed = utilityMoveCandidates(store, withRocks);
  assert.ok(
    !suppressed.some((candidate) => candidate.command === "ステルスロック"),
    "stealth rock should not be suggested when already set"
  );
}

// 相手が既に状態異常/ほのおタイプなら、おにびは候補から外す
{
  const burned = battleState({
    activeOwn: "ウォッシュロトム",
    activeOpponent: "ミミッキュ",
    extraFacts: { statuses: [{ side: "opponent", pokemon: "ミミッキュ", condition: "やけど" }] }
  });
  assert.ok(
    !utilityMoveCandidates(store, burned).some((candidate) => candidate.command === "おにび"),
    "おにび should be suppressed against an already-statused target"
  );

  const fireType = battleState({ activeOwn: "ウォッシュロトム", activeOpponent: "リザードン" });
  assert.ok(
    !utilityMoveCandidates(store, fireType).some((candidate) => candidate.command === "おにび"),
    "おにび should be suppressed against a Fire-type target"
  );
}

// --- 2. 被弾見積もり -----------------------------------------------------------

// 判明技が無い場合はタイプ一致仮定で見積もる。じめん技はふゆうのロトムに無効。
{
  const state = battleState({ activeOwn: "ウォッシュロトム", activeOpponent: "ガブリアス" });
  const threats = estimateIncomingThreats(store, state);
  assert.ok(threats.length > 0, "threats should be estimated even without revealed moves");
  assert.ok(threats.every((threat) => threat.assumed), "without revealed moves all threats are assumed");
  const ground = threats.find((threat) => threat.move.includes("Ground"));
  assert.ok(ground, `a Ground STAB assumption should exist: ${JSON.stringify(threats.map((t) => t.move))}`);
  assert.equal(ground.effectiveness, 0, "Ground move must be nullified by Levitate Rotom-W");
  const dragon = threats.find((threat) => threat.move.includes("Dragon"));
  assert.ok(dragon && dragon.percentMax > 0, "Dragon STAB assumption should deal damage");
}

// 判明技があればそれを優先して見積もる
{
  const state = battleState({
    activeOwn: "ウォッシュロトム",
    activeOpponent: "ミミッキュ",
    extraFacts: { revealedMoves: [{ pokemon: "ミミッキュ", move: "じゃれつく", certainty: "confirmed" }] }
  });
  const threats = estimateIncomingThreats(store, state);
  assert.equal(threats.length, 1, `revealed moves should replace assumptions: ${JSON.stringify(threats.map((t) => t.move))}`);
  assert.equal(threats[0].move, "じゃれつく");
  assert.equal(threats[0].assumed, false);
  assert.ok(threats[0].percentMax > 0, "revealed move should deal damage to Rotom-W");
}

// トリックルーム中は行動順の注記が反転する(実戦で「先手想定」の誤説明が出た回帰)
{
  const state = battleState({ activeOwn: "マスカーニャ", activeOpponent: "ミミッキュ" });
  const normal = estimateIncomingThreats(store, state);
  assert.ok(!normal[0].speedNote.includes("トリックルーム"), "no trick room note without trick room");
  const trickRoom = estimateIncomingThreats(store, { ...state, field: "全体: トリックルーム" });
  assert.match(trickRoom[0].speedNote, /トリックルーム/, "trick room must be reflected in the speed note");
  assert.match(trickRoom[0].speedNote, /遅い方が先/, "trick room note must explain inverted order");
  assert.match(trickRoom[0].speedNote, /相手が先手/, "fast Meowscarada must be predicted to move last under trick room");
}

// 交代先の受け出しリスク(データ無しの「メタグロスで受ける」誤交代が出た回帰)
{
  const state = battleState({ activeOwn: "ウォッシュロトム", activeOpponent: "ガブリアス" });
  const risks = estimateSwitchInRisks(store, state);
  const metagross = risks.find((risk) => risk.pokemon === "メタグロス");
  assert.ok(metagross, `switch-in risks must cover the bench: ${JSON.stringify(risks.map((r) => r.pokemon))}`);
  assert.equal(metagross.effectiveness, 2, "Ground STAB must be super effective on Metagross");
  assert.ok(metagross.percentMax > 40, `Metagross switch-in risk should be large: ${metagross.percentMax}%`);

  const summary = summarizeThreatReport(buildThreatReport(store, state));
  assert.match(summary, /交代先が受け出しした場合の最大被弾/, "summary must include switch-in risk section");
  assert.match(summary, /メタグロス/, "summary must mention bench Pokemon");
}

// --- 3. ガード: 正当な補助技は通し、無効技だけ差し替える -------------------------

function adviceWith(state, action, speech = "テストです。") {
  return { updatedState: state, action, speech, memo: "" };
}

// 候補プールに無い「おにび」でも、場のポケモンが覚えていれば差し替えない
{
  const state = battleState({ activeOwn: "ウォッシュロトム", activeOpponent: "ミミッキュ" });
  const candidates = [
    { kind: "move", command: "ハイドロポンプ", reason: "", risk: "", confidence: "high" }
  ];
  const advice = adviceWith(state, { kind: "move", command: "おにび", reason: "物理を止める", risk: "", confidence: "medium" });
  const repaired = repairInvalidBattleAdvice(store, advice, state, candidates);
  assert.equal(repaired.action.command, "おにび", "a legal utility move outside the candidate pool must survive the guard");
}

// 相手に無効(0倍)の技は候補側へ差し替える(ガブリアスのじしん→アーマーガア)
{
  const state = battleState({ activeOwn: "ガブリアス", activeOpponent: "アーマーガア" });
  const candidates = [
    { kind: "move", command: "ドラゴンクロー", reason: "等倍打点", risk: "", confidence: "medium" }
  ];
  const advice = adviceWith(state, { kind: "move", command: "じしん", reason: "", risk: "", confidence: "high" });
  const repaired = repairInvalidBattleAdvice(store, advice, state, candidates);
  assert.equal(repaired.action.command, "ドラゴンクロー", "an immune (0x) move must be replaced by a candidate");
  assert.match(repaired.speech, /無効/, "the correction speech should explain the immunity");
}

// 場のポケモンが覚えていない技は従来どおり差し替える
{
  const state = battleState({ activeOwn: "ガブリアス", activeOpponent: "ミミッキュ" });
  const candidates = [
    { kind: "move", command: "ドラゴンクロー", reason: "", risk: "", confidence: "medium" }
  ];
  const advice = adviceWith(state, { kind: "move", command: "りゅうせいぐん", reason: "", risk: "", confidence: "high" });
  const repaired = repairInvalidBattleAdvice(store, advice, state, candidates);
  assert.equal(repaired.action.command, "ドラゴンクロー", "a move not known by the active Pokemon must still be replaced");
}

console.log("turn evaluation tests passed");
