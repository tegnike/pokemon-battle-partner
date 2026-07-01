import fs from "node:fs";
import path from "node:path";
import { createInitialBattleState, normalizeBattleState, type BattleState, type BattleStatus } from "../domain";

export interface BattleSummary {
  battleId: string;
  opponentName: string;
  status: BattleStatus;
  phase: BattleState["phase"];
  turn: number;
  createdAt: string;
  updatedAt: string;
  latestMemo: string;
}

function sessionsDir(appRoot: string): string {
  return path.join(appRoot, "data", "battle-sessions");
}

function sessionFile(appRoot: string, battleId: string): string {
  return path.join(sessionsDir(appRoot), `${battleId}.json`);
}

function ensureSessionsDir(appRoot: string): void {
  fs.mkdirSync(sessionsDir(appRoot), { recursive: true });
}

export function saveBattleState(appRoot: string, state: BattleState): BattleState {
  ensureSessionsDir(appRoot);
  const normalized = normalizeBattleState({
    ...state,
    updatedAt: new Date().toISOString()
  });
  fs.writeFileSync(sessionFile(appRoot, normalized.battleId), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function createBattleSession(appRoot: string, opponentName = ""): BattleState {
  const trimmedOpponentName = opponentName.trim();
  if (!trimmedOpponentName) {
    const reusable = listBattleSessions(appRoot).find(
      (battle) => !battle.opponentName && battle.turn === 0 && battle.status === "active"
    );
    if (reusable) {
      const state = readBattleSession(appRoot, reusable.battleId);
      if (state) return state;
    }
  }
  const state = createInitialBattleState(trimmedOpponentName);
  return saveBattleState(appRoot, state);
}

export function readBattleSession(appRoot: string, battleId: string): BattleState | null {
  const file = sessionFile(appRoot, battleId);
  if (!fs.existsSync(file)) return null;
  return normalizeBattleState(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function listBattleSessions(appRoot: string): BattleSummary[] {
  ensureSessionsDir(appRoot);
  return fs
    .readdirSync(sessionsDir(appRoot))
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        const state = normalizeBattleState(JSON.parse(fs.readFileSync(path.join(sessionsDir(appRoot), file), "utf8")));
        return [
          {
            battleId: state.battleId,
            opponentName: state.opponentName,
            status: state.status,
            phase: state.phase,
            turn: state.turn,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            latestMemo: state.latestMemo
          }
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function patchBattleSession(
  appRoot: string,
  battleId: string,
  patch: Partial<Pick<BattleState, "opponentName" | "status" | "phase">>
): BattleState | null {
  const current = readBattleSession(appRoot, battleId);
  if (!current) return null;
  return saveBattleState(appRoot, { ...current, ...patch });
}
