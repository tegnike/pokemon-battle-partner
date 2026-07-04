// 実際のLLM APIを呼び出す統合テスト。
// tests/fixtures/battle-replays.json に記録された実対戦のターンを再生し、
// ワークフローの出力が対戦の不変条件を満たすことを検証する。
//
// 使い方:
//   npm run test:integration                     # 厳選シナリオのみ(バグ再現ターン含む、LLM呼び出し数を抑える)
//   npm run test:integration -- --battle c3096b  # battleIdプレフィックス指定で1試合を全ターン再生
//   npm run test:integration -- --all            # 5試合75ターンすべて再生(時間とAPI料金がかかる)
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeBattleState } from "../../src/domain.ts";
import { runBattleAdviceWorkflow } from "../../src/mastra/battleWorkflow.ts";

const appRoot = path.resolve(import.meta.dirname, "..", "..");
const fixturePath = path.join(appRoot, "tests", "fixtures", "battle-replays.json");
const teamDocPath =
  process.env.TEAM_DOC_PATH ?? "/Users/user/WorkSpace/nikechan/docs/pokemon-champions-ai-team.md";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Create .env from .env.example.");
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const args = process.argv.slice(2);
const runAll = args.includes("--all");
const battleFilter = args.includes("--battle") ? args[args.indexOf("--battle") + 1] : null;
const concurrency = 4;

// 過去に実際へ発生した不具合の再現ターンと、代表的な正常ターン。
// assert: 追加で検証する内容 / description: 何を守るテストか
const curatedScenarios = [
  {
    battlePrefix: "c306a3be", // キラッチ戦
    turnIndex: 1,
    description: "見せ合いから3体選出",
    assert: (result, preState) => {
      assert.equal(result.action.kind, "selection", "selection phase must produce a selection");
      const ownNames = preState.ownTeam.map((pokemon) => pokemon.name);
      const picked = ownNames.filter((name) => result.action.command.includes(name));
      assert.equal(picked.length, 3, `selection command must contain exactly 3 own Pokemon: ${result.action.command}`);
      assert.match(result.speech, /先発は/, "selection speech must announce the lead");
    }
  },
  {
    battlePrefix: "c3096bff", // ナノ戦: ガブリアスひんし後「次のポケモンを選んでください」→ 再選出に巻き戻ったバグの再現
    turnIndex: 11,
    description: "ひんし後の「次のポケモンを選んで」で再選出に戻らない",
    assert: (result) => {
      assert.notEqual(result.action.kind, "selection", "must not regress to team selection mid-battle");
      assert.equal(result.updatedState.phase, "battle", "phase must stay battle");
      assert.ok(
        result.action.kind === "switch" || result.action.kind === "move",
        `expected switch/move after own faint, got ${result.action.kind}:${result.action.command}`
      );
    }
  },
  {
    battlePrefix: "9fe400e6", // しめさば戦: 同一バグの2例目
    turnIndex: 5,
    description: "ひんし後の「次のポケモンをお願いします」で再選出に戻らない",
    assert: (result) => {
      assert.notEqual(result.action.kind, "selection", "must not regress to team selection mid-battle");
      assert.equal(result.updatedState.phase, "battle", "phase must stay battle");
    }
  },
  {
    battlePrefix: "c306a3be", // キラッチ戦: ひんし報告で「操作指示を止めます」と空振りしたターン
    turnIndex: 15,
    description: "ひんし報告に対して指示を止めず次の一手を返す",
    assert: (result) => {
      assert.notEqual(result.action.kind, "selection", "must not regress to team selection mid-battle");
      assert.ok(
        result.action.kind === "switch" || result.action.kind === "move",
        `expected an actionable instruction after own faint, got ${result.action.kind}:${result.action.command}`
      );
    }
  },
  {
    battlePrefix: "c3096bff", // ナノ戦: 勝利報告
    turnIndex: 17,
    description: "勝利報告には対戦指示を出さずに受ける",
    assert: (result) => {
      assert.equal(result.action.kind, "note", "victory report should be acknowledged with a note");
    }
  }
];

function ownMoveNames(state) {
  const names = new Set();
  for (const pokemon of state.ownTeam) {
    for (const move of pokemon.moves ?? []) {
      const value = typeof move === "string" ? move : move?.value;
      if (value) names.add(value);
    }
  }
  return names;
}

// 全ターン共通の不変条件。
function assertInvariants(result, preState, label) {
  assert.ok(result.action?.command !== undefined, `${label}: action.command missing`);
  assert.ok(result.speech?.trim(), `${label}: speech is empty`);
  assert.ok(!/\d(?:\.\d+)?\s*%/.test(result.speech), `${label}: raw percentage leaked into speech: ${result.speech}`);
  if (preState.phase === "battle" && preState.status === "active") {
    assert.equal(result.updatedState.phase, "battle", `${label}: phase regressed to ${result.updatedState.phase} mid-battle`);
    assert.notEqual(result.action.kind, "selection", `${label}: selection action returned mid-battle`);
    if (result.action.kind === "switch") {
      const target = preState.ownTeam.find((pokemon) => result.action.command.includes(pokemon.name));
      assert.ok(target, `${label}: switch target ${result.action.command} is not an own Pokemon`);
      assert.ok(target.selected, `${label}: switch target ${target.name} was not selected`);
      assert.ok(target.hpPercent !== 0 && target.condition !== "ひんし", `${label}: switch target ${target.name} is fainted`);
    }
    if (result.action.kind === "move") {
      assert.ok(ownMoveNames(preState).has(result.action.command), `${label}: move ${result.action.command} is not on our team`);
    }
  }
}

function buildDeps() {
  return {
    championsDataDir: path.join(appRoot, "data", "champions"),
    readTeamDoc: () => {
      try {
        return fs.readFileSync(teamDocPath, "utf8");
      } catch (error) {
        return `構築文書を読めませんでした: ${String(error)}`;
      }
    },
    appendBattleLog: () => {},
    adviceModel: process.env.ADVICE_MODEL ?? "gpt-5.4-mini",
    adviceReasoningEffort: process.env.ADVICE_REASONING_EFFORT ?? "none",
    requestTimeoutMs: Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 20_000),
    appendMemoryNotes: () => {}
  };
}

function collectTargets() {
  const targets = [];
  if (runAll || battleFilter) {
    for (const battle of fixture.battles) {
      if (battleFilter && !battle.battleId.startsWith(battleFilter)) continue;
      for (const turn of battle.turns) {
        targets.push({ battle, turn, extraAssert: null, description: null });
      }
    }
  } else {
    for (const scenario of curatedScenarios) {
      const battle = fixture.battles.find((entry) => entry.battleId.startsWith(scenario.battlePrefix));
      assert.ok(battle, `fixture battle not found: ${scenario.battlePrefix}`);
      const turn = battle.turns.find((entry) => entry.turnIndex === scenario.turnIndex);
      assert.ok(turn, `fixture turn not found: ${scenario.battlePrefix} turn ${scenario.turnIndex}`);
      targets.push({ battle, turn, extraAssert: scenario.assert, description: scenario.description });
    }
  }
  return targets;
}

async function runTarget(target) {
  const { battle, turn } = target;
  const label = `${battle.opponentName || battle.battleId.slice(0, 8)}戦 turn ${turn.turnIndex}`;
  const preState = normalizeBattleState(turn.preState);
  const started = Date.now();
  try {
    const result = await runBattleAdviceWorkflow(buildDeps(), {
      state: preState,
      transcript: turn.transcript,
      memoryContext: "",
      conversationIntent: "battle"
    });
    assertInvariants(result, preState, label);
    target.extraAssert?.(result, preState);
    return {
      label,
      description: target.description,
      ok: true,
      elapsedMs: Date.now() - started,
      action: `${result.action.kind}:${result.action.command}`,
      speech: result.speech
    };
  } catch (error) {
    return {
      label,
      description: target.description,
      ok: false,
      elapsedMs: Date.now() - started,
      error: error?.message ?? String(error)
    };
  }
}

async function main() {
  const targets = collectTargets();
  console.log(`replaying ${targets.length} turns with model ${process.env.ADVICE_MODEL ?? "gpt-5.4-mini"} (concurrency ${concurrency})`);
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        const result = await runTarget(target);
        results.push(result);
        const status = result.ok ? "PASS" : "FAIL";
        const detail = result.ok ? result.action : result.error;
        console.log(`[${status}] ${result.label}${result.description ? ` (${result.description})` : ""} ${Math.round(result.elapsedMs / 100) / 10}s → ${detail}`);
      }
    })
  );
  const reportDir = path.join(appRoot, "tmp");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "integration-replay-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  const failures = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failures.length}/${results.length} passed. report: ${path.relative(appRoot, reportPath)}`);
  if (failures.length > 0) process.exit(1);
}

await main();
