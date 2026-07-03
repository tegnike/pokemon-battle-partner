import assert from "node:assert/strict";
import { createInitialBattleState } from "../src/domain.ts";
import { summarizeBattleStatus } from "../src/fieldStatus.ts";

const state = createInitialBattleState();
state.field = "全体: 雨 / エレキフィールド / 相手側: ステルスロック 1回 / 自分側: おいかぜ 3ターン / まきびし";
state.ownTeam[0].selected = true;
state.ownTeam[0].active = true;
state.ownTeam[0].statChanges = "素早さ-1";
state.opponentTeam[0].name = "ゲンガー";
state.opponentTeam[0].selected = true;
state.opponentTeam[0].active = true;
state.opponentTeam[0].condition = "まひ";

const summary = summarizeBattleStatus(state);

assert.ok(summary.global.some((item) => item.label === "雨"));
assert.ok(summary.global.some((item) => item.label === "エレキフィールド"));
assert.ok(summary.opponent.some((item) => item.label === "ステルスロック"));
assert.ok(summary.own.some((item) => item.label === "おいかぜ"));
assert.ok(summary.unknown.some((item) => item.label === "まきびし" && item.detail.includes("側不明")));
assert.ok(summary.pokemon.some((item) => item.label === "自分 ガブリアス" && item.detail.includes("素早さ-1")));
assert.ok(summary.pokemon.some((item) => item.label === "相手 ゲンガー" && item.detail.includes("まひ")));

console.log("field-status tests passed");
