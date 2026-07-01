import fs from "node:fs";
import path from "node:path";
import type { AdviceResult, BattleState } from "../domain";

export type MemoryScope = "global" | "preference" | "team" | "battle" | "opponent";
export type MemoryConfidence = "confirmed" | "inferred";

export interface ConversationTurnMemory {
  id: string;
  battleId: string;
  createdAt: string;
  userText: string;
  assistantCommand: string;
  assistantMemo: string;
  phase: BattleState["phase"];
}

export interface LongTermMemoryNote {
  id: string;
  scope: MemoryScope;
  content: string;
  sourceTranscript: string;
  confidence: MemoryConfidence;
  tags: string[];
  battleId?: string;
  createdAt: string;
}

export interface MemoryContext {
  recentTurns: ConversationTurnMemory[];
  relevantNotes: LongTermMemoryNote[];
  text: string;
}

const RECENT_TURN_LIMIT = 20;
const RELEVANT_NOTE_LIMIT = 12;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function appendJsonl(file: string, payload: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
}

function memoryRoot(appRoot: string): string {
  return path.join(appRoot, "data", "memory");
}

function recentTurnsFile(appRoot: string): string {
  return path.join(memoryRoot(appRoot), "recent-turns.jsonl");
}

function noteFile(appRoot: string, scope: MemoryScope): string {
  return path.join(memoryRoot(appRoot), "notes", `${scope}.jsonl`);
}

function summaryFile(appRoot: string, scope: MemoryScope): string {
  return path.join(memoryRoot(appRoot), "summaries", `${scope}.md`);
}

function noteFiles(appRoot: string): string[] {
  return (["global", "preference", "team", "battle", "opponent"] satisfies MemoryScope[]).map((scope) =>
    noteFile(appRoot, scope)
  );
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/\s+/g, "");
}

function tokens(value: string): string[] {
  const normalized = normalizeForSearch(value);
  const words = value
    .toLowerCase()
    .normalize("NFKC")
    .split(/[、。,.!！?？\s/()[\]{}:;「」『』"'`]+/)
    .filter((entry) => entry.length >= 2);
  const chunks: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 2) {
    chunks.push(normalized.slice(index, index + 4));
  }
  return [...new Set([...words, ...chunks].filter((entry) => entry.length >= 2))];
}

function scoreNote(note: LongTermMemoryNote, query: string, battleId: string): number {
  const haystack = normalizeForSearch([note.content, note.tags.join(" "), note.scope].join(" "));
  const queryTokens = tokens(query);
  let score = note.battleId === battleId ? 2 : 0;
  for (const token of queryTokens) {
    if (haystack.includes(normalizeForSearch(token))) score += 1;
  }
  if (note.scope === "preference" || note.scope === "team") score += 0.5;
  return score;
}

function renderRecentTurns(turns: ConversationTurnMemory[]): string {
  if (turns.length === 0) return "なし";
  return turns
    .map((turn, index) =>
      [
        `${index + 1}. [${turn.phase}] user: ${turn.userText}`,
        `   assistant: ${turn.assistantCommand}`,
        turn.assistantMemo ? `   memo: ${turn.assistantMemo}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n");
}

function renderNotes(notes: LongTermMemoryNote[]): string {
  if (notes.length === 0) return "なし";
  return notes
    .map((note) => `- (${note.scope}/${note.confidence}) ${note.content}${note.tags.length ? ` [${note.tags.join(", ")}]` : ""}`)
    .join("\n");
}

function rebuildScopeSummary(appRoot: string, scope: MemoryScope): void {
  const notes = readJsonl<LongTermMemoryNote>(noteFile(appRoot, scope));
  const lines = [
    `# ${scope} memory`,
    "",
    `更新日時: ${new Date().toISOString()}`,
    "",
    ...notes.slice(-200).map((note) => `- ${note.content} (${note.confidence}; ${note.createdAt})`)
  ];
  ensureDir(path.dirname(summaryFile(appRoot, scope)));
  fs.writeFileSync(summaryFile(appRoot, scope), `${lines.join("\n")}\n`);
}

export function readMemoryContext(appRoot: string, query: string, battleId: string): MemoryContext {
  const recentTurns = readJsonl<ConversationTurnMemory>(recentTurnsFile(appRoot)).slice(-RECENT_TURN_LIMIT);
  const allNotes = noteFiles(appRoot).flatMap((file) => readJsonl<LongTermMemoryNote>(file));
  const relevantNotes = allNotes
    .map((note) => ({ note, score: scoreNote(note, query, battleId) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, RELEVANT_NOTE_LIMIT)
    .map((entry) => entry.note);

  const text = [
    "## 直近20ターンの会話",
    renderRecentTurns(recentTurns),
    "",
    "## 関連する長期記憶",
    renderNotes(relevantNotes)
  ].join("\n");

  return { recentTurns, relevantNotes, text };
}

export function appendConversationTurn(
  appRoot: string,
  state: BattleState,
  transcript: string,
  result: AdviceResult
): ConversationTurnMemory {
  const turn: ConversationTurnMemory = {
    id: crypto.randomUUID(),
    battleId: state.battleId,
    createdAt: new Date().toISOString(),
    userText: transcript,
    assistantCommand: result.action.command,
    assistantMemo: result.memo,
    phase: result.updatedState.phase
  };
  appendJsonl(recentTurnsFile(appRoot), turn);
  return turn;
}

export function appendLongTermMemoryNotes(appRoot: string, notes: LongTermMemoryNote[]): void {
  const seenScopes = new Set<MemoryScope>();
  for (const note of notes) {
    if (!note.content.trim()) continue;
    const existing = readJsonl<LongTermMemoryNote>(noteFile(appRoot, note.scope));
    const normalizedContent = normalizeForSearch(note.content);
    if (existing.some((entry) => normalizeForSearch(entry.content) === normalizedContent)) continue;
    appendJsonl(noteFile(appRoot, note.scope), note);
    seenScopes.add(note.scope);
  }
  for (const scope of seenScopes) {
    rebuildScopeSummary(appRoot, scope);
  }
}
