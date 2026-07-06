// 構造化FieldState(fieldState.ts)とマージ意味論の回帰テスト。
// 守るもの:
// 1. 新しい場の観測が既存の記録を消さない(かつての「全置換」バグの再発防止)
// 2. 天候の置き換え・場の効果の解除・重複排除・側の昇格が決定的に動く
// 3. workflow のダメージ補正が単一パーサ経由で壁・天候を反映する
import assert from "node:assert/strict";
import path from "node:path";
import {
  applyFieldObservation,
  emptyFieldState,
  mergeFieldText,
  parseFieldState,
  serializeFieldState,
  sideHasFieldEffect,
  sideHasTailwind,
  fieldWeatherLabel
} from "../src/fieldState.ts";
import { createInitialBattleState } from "../src/domain.ts";
import { applyFactsToState, localActiveMoveCandidates } from "../src/mastra/battleWorkflow.ts";
import { createLocalDataStore } from "../src/mastra/localData.ts";

const store = createLocalDataStore(path.resolve("data/champions"));

// --- 1. マージが情報を失わない ---------------------------------------------------

// かつての実装: facts.field="全体: 雨" が来ると field 全体が置換され、ステロの記録が消えた。
{
  const merged = mergeFieldText("相手側: ステルスロック / 自分側: リフレクター", "全体: 雨");
  assert.match(merged, /雨/, "new weather must be recorded");
  assert.match(merged, /相手側: ステルスロック/, "existing hazard must survive a weather report");
  assert.match(merged, /自分側: リフレクター/, "existing screen must survive a weather report");
}

// 同じ観測を二度受けても重複しない(LLMが現在のfieldを書き写しても安全)
{
  const once = mergeFieldText("", "相手側: ステルスロック / 全体: 雨");
  const twice = mergeFieldText(once, "相手側: ステルスロック / 全体: 雨");
  assert.equal(once, twice, "merge must be idempotent");
}

// 正規形はラウンドトリップで安定する
{
  const canonical = mergeFieldText("", "全体: 雨 / 相手側: ひかりのかべ / 自分側: おいかぜ");
  assert.equal(serializeFieldState(parseFieldState(canonical)), canonical, "serialize(parse(x)) must be stable");
}

// --- 2. 置き換え・解除・側の昇格 --------------------------------------------------

// 天候は同時に1つ。晴れの観測が雨を置き換える。
{
  const merged = mergeFieldText("全体: 雨 / 相手側: ステルスロック", "晴れになった");
  assert.equal(fieldWeatherLabel(merged), "晴れ", "new weather replaces the old one");
  assert.match(merged, /ステルスロック/, "hazards survive weather changes");
}

// 「強い雨」は「雨」より特異的なラベルを優先する
{
  const state = applyFieldObservation(emptyFieldState(), "全体: 強い雨");
  assert.equal(state.weather?.label, "強い雨");
}

// 解除報告は該当効果だけを取り除く
{
  const merged = mergeFieldText("全体: 雨 / 相手側: リフレクター / 相手側: ステルスロック", "相手側: リフレクター解除");
  assert.ok(!/リフレクター/.test(merged), "removed screen must disappear");
  assert.match(merged, /ステルスロック/, "other effects must remain");
  assert.equal(fieldWeatherLabel(merged), "雨", "weather must remain");
}

// 天候の終了
{
  const merged = mergeFieldText("全体: 雨 / 相手側: ステルスロック", "雨がやんだ");
  assert.equal(fieldWeatherLabel(merged), "", "weather removal must clear weather");
  assert.match(merged, /ステルスロック/);
}

// 側不明で記録された効果は、側が判明したら昇格する
{
  const merged = mergeFieldText("側不明: ステルスロック", "相手側: ステルスロック");
  assert.match(merged, /相手側: ステルスロック/);
  assert.ok(!/側不明/.test(merged), "unknown-side entry must be promoted, not duplicated");
}

// 定義に無い自由文は notes として保持される
{
  const merged = mergeFieldText("", "みがわりが場に残っている");
  assert.match(merged, /みがわり/, "unmatched observations must be kept as notes");
}

// --- 3. 判定ヘルパーとダメージ補正の統合 -----------------------------------------

{
  const field = mergeFieldText("", "自分側: おいかぜ / 相手側: ひかりのかべ");
  assert.equal(sideHasTailwind(field, "own"), true);
  assert.equal(sideHasTailwind(field, "opponent"), false);
  assert.equal(sideHasFieldEffect(field, "opponent", "ひかりのかべ"), true);
  assert.equal(sideHasFieldEffect(field, "own", "ひかりのかべ"), false);
  // 側不明の効果は保守的に「効いていない」扱い
  assert.equal(sideHasFieldEffect("側不明: ひかりのかべ", "opponent", "ひかりのかべ"), false);
}

// ダメージ補正: 壁で半減、雨でみず技強化 (単一パーサ経由で動くことの確認)
{
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
  let state = createInitialBattleState("テスト");
  state = { ...state, phase: "battle", status: "active" };
  state = applyFactsToState(
    state,
    emptyFacts({
      phase: "battle",
      ownSelectedPokemon: ["ガブリアス", "メタグロス", "ウォッシュロトム"],
      activeOwn: "ウォッシュロトム",
      activeOpponent: "ミミッキュ"
    }),
    store
  );
  const hydroPercent = (candidates) =>
    candidates.find((candidate) => candidate.command === "ハイドロポンプ")?.moveMatchup?.percentMax ?? null;

  const neutral = hydroPercent(localActiveMoveCandidates(store, state));
  const rain = hydroPercent(localActiveMoveCandidates(store, { ...state, field: mergeFieldText("", "全体: 雨") }));
  const screened = hydroPercent(
    localActiveMoveCandidates(store, { ...state, field: mergeFieldText("", "相手側: ひかりのかべ") })
  );
  assert.ok(neutral !== null && rain !== null && screened !== null, "hydro pump matchup must be computable");
  assert.ok(Math.abs(rain - neutral * 1.5) < 0.2, `rain must boost water moves 1.5x (neutral=${neutral}, rain=${rain})`);
  assert.ok(Math.abs(screened - neutral * 0.5) < 0.2, `light screen must halve special moves (neutral=${neutral}, screened=${screened})`);
}

// applyFactsToState 経由のエンドツーエンド: 雨の報告でステロが消えない
{
  function factsWithField(field) {
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
      field
    };
  }
  let state = createInitialBattleState("テスト");
  state = { ...state, phase: "battle", status: "active" };
  state = applyFactsToState(state, factsWithField("相手側: ステルスロック"), store);
  assert.match(state.field, /相手側: ステルスロック/);
  state = applyFactsToState(state, factsWithField("全体: 雨"), store);
  assert.match(state.field, /雨/, "rain must be recorded via facts");
  assert.match(state.field, /相手側: ステルスロック/, "stealth rock must survive a rain report via facts");
}

console.log("field state tests passed");
