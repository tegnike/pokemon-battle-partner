import assert from "node:assert/strict";
import path from "node:path";
import { createInitialBattleState } from "../src/domain.ts";
import {
  applyFactsToState,
  localReplacementCandidates
} from "../src/mastra/battleWorkflow.ts";
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

// 対戦中(battle/active)で選出3体が確定し、ガブリアスが場にいる状態を作る。
let battleState = createInitialBattleState("ナノ");
battleState = { ...battleState, phase: "battle", status: "active" };
battleState = applyFactsToState(
  battleState,
  emptyFacts({
    phase: "battle",
    ownSelectedPokemon: ["ガブリアス", "メタグロス", "ウォッシュロトム"],
    activeOwn: "ガブリアス"
  }),
  store
);
assert.equal(battleState.phase, "battle");
assert.equal(battleState.activeOwn, "ガブリアス");

// 自分のポケモンがひんしになった直後、抽出器が誤って phase="selection" を返しても
// 同一対戦内では battle を維持する(ひんし後の「次のポケモンを選んで」は交代であって再選出ではない)。
const afterFaint = applyFactsToState(
  battleState,
  emptyFacts({
    phase: "selection",
    faintedPokemon: [{ side: "own", pokemon: "ガブリアス" }]
  }),
  store
);
assert.equal(afterFaint.phase, "battle", "phase must stay battle after own faint mid-battle");

// ひんし後は控えの選出済みポケモンだけが交代候補になる。
const replacements = localReplacementCandidates(afterFaint).map((candidate) => candidate.command);
assert.deepEqual(replacements.sort(), ["ウォッシュロトム", "メタグロス"].sort());

// 対戦終了後(status=review)の新規対戦準備など、battle中でなければ selection への遷移は今まで通り許可する。
const reviewState = { ...battleState, status: "review" };
const backToSelection = applyFactsToState(reviewState, emptyFacts({ phase: "selection" }), store);
assert.equal(backToSelection.phase, "selection", "non-active battle may return to selection");

console.log("phase regression tests passed");
