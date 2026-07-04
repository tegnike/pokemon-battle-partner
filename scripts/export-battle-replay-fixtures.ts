// data/battles/*.jsonl の対戦ログから統合テスト用リプレイフィクスチャを生成する。
// 各ターンの入力stateは、前ターンの result.updatedState にサーバーと同じ
// 保存時パッチ(turn+1、history追記、latestMemo)を当てて再構成する。
// 使い方: npx tsx scripts/export-battle-replay-fixtures.ts <battleId...>
import fs from "node:fs";
import path from "node:path";
import { createInitialBattleState, normalizeBattleState, type BattleState } from "../src/domain.ts";

const appRoot = path.resolve(import.meta.dirname, "..");
const battlesDir = path.join(appRoot, "data", "battles");
const outPath = path.join(appRoot, "tests", "fixtures", "battle-replays.json");

const targetBattleIds = process.argv.slice(2);
if (targetBattleIds.length === 0) {
  console.error("usage: npx tsx scripts/export-battle-replay-fixtures.ts <battleId...>");
  process.exit(1);
}

interface LogRecord {
  createdAt: string;
  battleId: string;
  transcript: string;
  result: {
    updatedState: BattleState;
    action: { kind: string; command: string };
    memo: string;
  };
}

function compactActionLabel(action: string, kind?: string, memo = ""): string {
  const trimmed = action.trim();
  const combined = `${trimmed}\n${memo}`;
  if (!trimmed) return "状況確認";
  if (kind === "note" || trimmed === "note") {
    if (combined.includes("選出理由")) return "選出理由";
    if (combined.includes("理由")) return "理由説明";
    if (combined.includes("覚えて")) return "記憶";
    if (combined.includes("反省")) return "反省会";
    return "状況確認";
  }
  if (trimmed.length <= 18) return trimmed;
  if (combined.includes("選出理由")) return "選出理由";
  if (kind === "selection" || combined.includes("選出")) return "選出";
  if (combined.includes("理由")) return "理由説明";
  return "会話";
}

const records = new Map<string, LogRecord[]>();
for (const file of fs.readdirSync(battlesDir).filter((name) => name.endsWith(".jsonl")).sort()) {
  for (const line of fs.readFileSync(path.join(battlesDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as LogRecord;
    if (!targetBattleIds.includes(record.battleId)) continue;
    if (!record.result?.updatedState) continue;
    const list = records.get(record.battleId) ?? [];
    list.push(record);
    records.set(record.battleId, list);
  }
}

const battles = [];
for (const battleId of targetBattleIds) {
  const list = (records.get(battleId) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (list.length === 0) {
    console.error(`no records found for battle ${battleId}`);
    process.exit(1);
  }
  const startState = list[0].result.updatedState;
  let preState: BattleState = normalizeBattleState({
    ...createInitialBattleState(startState.opponentName),
    battleId,
    createdAt: startState.createdAt,
    updatedAt: startState.createdAt
  });
  const turns = [];
  for (const [index, record] of list.entries()) {
    turns.push({
      turnIndex: index + 1,
      transcript: record.transcript,
      preState,
      logged: {
        actionKind: record.result.action.kind,
        actionCommand: record.result.action.command,
        phase: record.result.updatedState.phase
      }
    });
    const updated = record.result.updatedState;
    const turn = preState.turn + 1;
    const turnEntry = {
      turn,
      transcript: record.transcript,
      action: compactActionLabel(record.result.action.command, record.result.action.kind, record.result.memo),
      memo: record.result.memo,
      createdAt: record.createdAt
    };
    preState = normalizeBattleState({
      ...updated,
      battleId,
      opponentName: updated.opponentName || preState.opponentName,
      status: preState.status,
      createdAt: preState.createdAt,
      turn,
      latestMemo: record.result.memo,
      history: [...(updated.history ?? []).slice(-19), turnEntry]
    });
  }
  battles.push({
    battleId,
    opponentName: preState.opponentName,
    turnCount: turns.length,
    turns
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify({ generatedFrom: "data/battles/*.jsonl", battles }, null, 2)}\n`);
console.log(`wrote ${battles.length} battles (${battles.reduce((sum, battle) => sum + battle.turnCount, 0)} turns) to ${path.relative(appRoot, outPath)}`);
