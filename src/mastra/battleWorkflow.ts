import { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import fs from "node:fs";
import path from "node:path";
import type { ReasoningEffort } from "openai/resources/shared";
import { z } from "zod";
import {
  type AdviceResult,
  type BattleState,
  type KnownValue,
  type PokemonState,
  createPokemon,
  normalizeBattleState
} from "../domain";
import { calculateChampionsStats, type NatureModifiers, type StatPoints } from "../champions/statCalc";
import { calculateLocalDamage, typeEffectiveness } from "./damage";
import { createLocalDataStore, type LocalDataStore, type LocalPokemon, type LocalMove, type StatBoosts } from "./localData";
import {
  applyOwnMegaEvolutions,
  applyOpponentMegaEvolutions,
  collectMegaEvolutions,
  inferMegaEvolution,
  rewriteOwnMegaFactReferences,
  rewriteOpponentMegaFactReferences
} from "./megaEvolution";
import {
  type BattleFacts,
  adviceResultSchema,
  battleFactsLooseSchema,
  battleFactsSchema,
  battleStateSchema,
  longTermMemoryNoteSchema,
  workflowInputSchema,
  workflowOutputSchema
} from "./schemas";
import { createDamageCalcTool, createMoveLookupTool, createPokemonLookupTool } from "./tools";

export interface BattleAdviceWorkflowDeps {
  championsDataDir: string;
  readTeamDoc: () => string;
  appendBattleLog: (payload: unknown) => void;
  adviceModel: string;
  adviceReasoningEffort: ReasoningEffort;
  requestTimeoutMs: number;
  abortSignal?: AbortSignal;
  appendMemoryNotes: (
    notes: Array<z.infer<typeof longTermMemoryNoteSchema> & { sourceTranscript: string; battleId?: string }>
  ) => void;
}

const normalizedPayloadSchema = z.object({
  state: battleStateSchema,
  transcript: z.string(),
  traceId: z.string(),
  teamDoc: z.string(),
  timings: z.record(z.string(), z.number()),
  memoryContext: z.string(),
  conversationIntent: z.enum(["battle", "chat", "memory"])
});

const factsPayloadSchema = normalizedPayloadSchema.extend({
  facts: battleFactsSchema
});

const resolvedPayloadSchema = factsPayloadSchema.extend({
  resolvedNames: z.record(z.string(), z.string().nullable()),
  localKnowledge: z.string()
});

const updatedPayloadSchema = resolvedPayloadSchema.extend({
  updatedState: battleStateSchema,
  damageCalcs: z.array(z.unknown())
});

const moveMatchupSchema = z.object({
  attacker: z.string(),
  defender: z.string(),
  move: z.string(),
  moveType: z.string(),
  effectiveness: z.number(),
  priority: z.number(),
  percentMin: z.number(),
  percentMax: z.number(),
  userEffectiveSpeed: z.number().nullable(),
  targetEffectiveSpeed: z.number().nullable(),
  userMovesFirstBySpeed: z.boolean().nullable(),
  note: z.string()
});
const candidateMoveMatchupSchema = moveMatchupSchema.extend({
  percentMin: z.number().nullable(),
  percentMax: z.number().nullable()
});

const candidateActionSchema = z.object({
  kind: z.enum(["selection", "move", "switch", "note"]),
  command: z.string(),
  reason: z.string(),
  risk: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  moveMatchup: candidateMoveMatchupSchema.optional(),
  speedComparison: z
    .object({
      subject: z.string(),
      target: z.string(),
      subjectSpeed: z.number(),
      targetMaxSpeed: z.number(),
      subjectEffectiveSpeed: z.number(),
      targetEffectiveSpeed: z.number(),
      targetMegaOptions: z.array(z.object({
        name: z.string(),
        maxSpeed: z.number(),
        effectiveSpeed: z.number()
      })),
      contextNote: z.string()
    })
    .optional()
});
export type CandidateAction = z.infer<typeof candidateActionSchema>;

type MoveMatchup = z.infer<typeof moveMatchupSchema>;

function hasCompleteMoveMatchup(matchup: CandidateAction["moveMatchup"]): matchup is MoveMatchup {
  return Boolean(
    matchup &&
      typeof matchup.percentMin === "number" &&
      typeof matchup.percentMax === "number" &&
      Number.isFinite(matchup.percentMin) &&
      Number.isFinite(matchup.percentMax)
  );
}

interface SpeedComparisonAction extends CandidateAction {
  speedComparison?: {
    subject: string;
    target: string;
    subjectSpeed: number;
    targetMaxSpeed: number;
    subjectEffectiveSpeed: number;
    targetEffectiveSpeed: number;
    targetMegaOptions: Array<{ name: string; maxSpeed: number; effectiveSpeed: number }>;
    contextNote: string;
  };
}

const finalDecisionSchema = z.object({
  action: candidateActionSchema,
  speech: z.string(),
  memo: z.string(),
  selectedOwnPokemon: z.array(z.string()).optional()
});

const candidatesPayloadSchema = updatedPayloadSchema.extend({
  candidates: z.array(candidateActionSchema).min(1).max(5),
  candidateToolCalls: z.array(z.unknown())
});

const advicePayloadSchema = updatedPayloadSchema.extend({
  candidates: z.array(candidateActionSchema).min(1).max(5),
  candidateToolCalls: z.array(z.unknown()),
  advice: adviceResultSchema,
  decisionToolCalls: z.array(z.unknown())
});

const memoryNotesPayloadSchema = advicePayloadSchema.extend({
  memoryNotes: z.array(longTermMemoryNoteSchema).max(5)
});

function toMastraModel(model: string): string {
  return model.includes("/") ? model : `openai/${model}`;
}

function providerOptions(reasoningEffort: ReasoningEffort) {
  return {
    openai: {
      reasoningEffort
    }
  };
}

function timeoutSignal(ms: number, parentSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!parentSignal) return timeout;
  if (parentSignal.aborted) return AbortSignal.abort(parentSignal.reason);
  return AbortSignal.any([timeout, parentSignal]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
}

// LLMの構造化出力は稀にスキーマ不一致や欠落で失敗する。1回だけリトライし、
// それでも取れなければ null を返して呼び出し側のローカルフォールバックに委ねる。
// ユーザー起因の中断(parentSignal)だけはリトライせずそのまま投げる。
async function generateObjectWithRetry<T extends { object?: unknown }>(
  attempt: () => Promise<T>,
  parentSignal: AbortSignal | undefined,
  label: string
): Promise<T | null> {
  for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
    try {
      const result = await attempt();
      throwIfAborted(parentSignal);
      if (result.object !== undefined && result.object !== null) return result;
      console.warn(`[battleAdviceWorkflow] ${label}: structured output missing (attempt ${tryIndex + 1}/2)`);
    } catch (error) {
      throwIfAborted(parentSignal);
      console.warn(
        `[battleAdviceWorkflow] ${label}: structured output failed (attempt ${tryIndex + 1}/2):`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return null;
}

async function timed<T extends { timings: Record<string, number> }, R>(
  payload: T,
  label: string,
  work: () => Promise<R>
): Promise<R & { timings: Record<string, number> }> {
  const startedAt = performance.now();
  const result = await work();
  const timings = {
    ...payload.timings,
    [label]: Math.round(performance.now() - startedAt)
  };
  return { ...(result as R), timings };
}

function limitText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...省略...`;
}

function compactTeamDoc(doc: string): string {
  const fallback = `
固定構築:
- ガブリアス: さめはだ / きあいのタスキ / じしん・ドラゴンクロー・がんせきふうじ・ステルスロック
- アシレーヌ: げきりゅう / オボンのみ / うたかたのアリア・ムーンフォース・れいとうビーム・エナジーボール
- メタグロス: クリアボディ / メタグロスナイト / じしん・れいとうパンチ・サイコファング・バレットパンチ
- ウォッシュロトム: ふゆう / たべのこし / ハイドロポンプ・10まんボルト・おにび・ボルトチェンジ
- マスカーニャ: へんげんじざい / いのちのたま / トリックフラワー・はたきおとす・トリプルアクセル・ふいうち
- サザンドラ: ふゆう / こだわりスカーフ / りゅうせいぐん・あくのはどう・かえんほうしゃ・とんぼがえり

基本方針:
- 基本選出はガブリアス、アシレーヌ、メタグロス。
- ライチュウ、特にメガライチュウYが見えたらガブリアスを厚めに見る。
- 雨ラグ展開はウォッシュロトム、アシレーヌ、マスカーニャを優先。
- ラグラージやカバルドンにはマスカーニャ、アシレーヌの草打点。
- アーマーガア、ペリッパー、水飛行にはウォッシュロトムやサザンドラのかえんほうしゃを意識。
- ブリジュラスはガブリアスのじしん、メタグロスのじしん、アシレーヌのムーンフォースで見る。
- 対戦中は次の一手だけを返す。交代読み前提より、対面で分かりやすい安定行動を優先。
`.trim();
  if (!doc.trim()) return fallback;
  const finalPartyMatch = doc.match(/## 最終パーティ[\s\S]*?(?=\n## )/);
  const rulesMatch = doc.match(/## 主要仮想敵への考え方[\s\S]*?(?=\n## |$)/);
  return limitText([finalPartyMatch?.[0], rulesMatch?.[0], fallback].filter(Boolean).join("\n\n"), 5000);
}

function compactPokemonForPrompt(pokemon: PokemonState, side: "own" | "opponent") {
  return {
    name: pokemon.name || "未確認",
    selected: pokemon.selected,
    active: pokemon.active,
    hp: side === "own" && pokemon.maxHp ? `${pokemon.currentHp ?? pokemon.maxHp}/${pokemon.maxHp}` : `${pokemon.hpPercent ?? 100}%`,
    condition: pokemon.condition || undefined,
    ability: pokemon.ability.value || undefined,
    item: pokemon.item.value || undefined,
    moves: pokemon.moves.map((move) => move.value).filter(Boolean),
    notes: pokemon.notes || undefined
  };
}

const natureByJaName: Record<string, NatureModifiers> = {
  いじっぱり: { plus: "atk", minus: "spa" },
  ひかえめ: { plus: "spa", minus: "atk" },
  ずぶとい: { plus: "def", minus: "atk" },
  おくびょう: { plus: "spe", minus: "atk" },
  ようき: { plus: "spe", minus: "spa" },
  わんぱく: { plus: "def", minus: "spa" },
  おだやか: { plus: "spd", minus: "atk" },
  しんちょう: { plus: "spd", minus: "spa" },
  のんき: { plus: "def", minus: "spe" },
  れいせい: { plus: "spa", minus: "spe" },
  なまいき: { plus: "spd", minus: "spe" },
  ゆうかん: { plus: "atk", minus: "spe" }
};

const statPointKeyByLabel: Record<string, keyof StatPoints> = {
  H: "hp",
  A: "atk",
  B: "def",
  C: "spa",
  D: "spd",
  S: "spe"
};

function parseStatProfile(notes: string): { nature?: NatureModifiers; statPoints: StatPoints } {
  const statPoints: StatPoints = {};
  for (const [natureName, nature] of Object.entries(natureByJaName)) {
    if (notes.includes(natureName)) {
      for (const match of notes.matchAll(/\b([HABCDS])(\d{1,2})\b/g)) {
        const key = statPointKeyByLabel[match[1]];
        if (key) statPoints[key] = Number(match[2]);
      }
      return { nature, statPoints };
    }
  }
  for (const match of notes.matchAll(/\b([HABCDS])(\d{1,2})\b/g)) {
    const key = statPointKeyByLabel[match[1]];
    if (key) statPoints[key] = Number(match[2]);
  }
  return { statPoints };
}

function maxUnboostedSpeed(pokemon: LocalPokemon): number {
  return calculateChampionsStats({
    baseStats: pokemon.baseStats,
    statPoints: { spe: 32 },
    nature: { plus: "spe", minus: "atk" }
  }).spe;
}

function baseIdFromMegaId(id: string): string | null {
  if (id.endsWith("megax") || id.endsWith("megay")) return id.slice(0, -5);
  if (id.endsWith("mega")) return id.slice(0, -4);
  return null;
}

function megaPokemonForBase(store: LocalDataStore, pokemon: LocalPokemon): LocalPokemon[] {
  if (pokemon.isMega) return [];
  return store
    .listPokemon()
    .filter((entry) => entry.isMega && baseIdFromMegaId(entry.id) === pokemon.id)
    .sort((left, right) => maxUnboostedSpeed(right) - maxUnboostedSpeed(left));
}

function localPokemonForName(store: LocalDataStore, name: string): LocalPokemon | null {
  const direct = store.getPokemon(name);
  if (direct) return direct;
  const trimmed = name.trim().normalize("NFKC");
  if (!trimmed.startsWith("メガ") || trimmed.length <= 2) return null;
  const body = trimmed.slice(2);
  const variant = body.match(/[XY]$/i)?.[0]?.toLowerCase();
  const baseName = variant ? body.slice(0, -1) : body;
  const base = store.getPokemon(baseName);
  if (!base) return null;
  const megas = megaPokemonForBase(store, base);
  return variant
    ? megas.find((pokemon) => pokemon.id.endsWith(`mega${variant}`)) ?? null
    : megas[0] ?? null;
}

function battleLocalPokemonForState(store: LocalDataStore, pokemon: PokemonState): LocalPokemon | null {
  const local = localPokemonForName(store, pokemon.name);
  if (!local) return null;
  const megas = megaPokemonForBase(store, local);
  if (megas.length > 0 && isKnownMegaState(pokemon, local)) return megas[0];
  return local;
}

function battlePokemonNameForCalc(store: LocalDataStore, pokemon: PokemonState): string {
  const local = battleLocalPokemonForState(store, pokemon);
  return local?.aliasesJa[0] ?? pokemon.name;
}

function displayPokemonName(pokemon: LocalPokemon, fallback: string): string {
  return pokemon.aliasesJa[0] ?? fallback;
}

function displayMegaPokemonName(pokemon: LocalPokemon, baseName: string): string {
  if (pokemon.aliasesJa[0]) return pokemon.aliasesJa[0];
  if (pokemon.id.endsWith("megax")) return `メガ${baseName}X`;
  if (pokemon.id.endsWith("megay")) return `メガ${baseName}Y`;
  return `メガ${baseName}`;
}

function knownOwnSpeed(store: LocalDataStore, pokemon: PokemonState): number | null {
  const local = battleLocalPokemonForState(store, pokemon);
  if (!local) return null;
  const profile = parseStatProfile(pokemon.notes);
  if (profile.statPoints.spe === undefined || !profile.nature) return null;
  return calculateChampionsStats({
    baseStats: local.baseStats,
    statPoints: profile.statPoints,
    nature: profile.nature
  }).spe;
}

function describeSpeedData(store: LocalDataStore, state: BattleState, name: string): string | null {
  const local = localPokemonForName(store, name);
  if (!local) return null;
  const own = state.ownTeam.find((pokemon) => pokemon.name === name);
  const ownSpeed = own ? knownOwnSpeed(store, own) : null;
  const displayName = local.aliasesJa[0] ?? name;
  const ownText = ownSpeed === null ? "" : `; ownKnownSpeed=${ownSpeed}; ownNotes=${own?.notes ?? ""}`;
  return `- ${displayName}: baseSpe=${local.baseStats.spe}; maxUnboostedSpeed=${maxUnboostedSpeed(local)}${ownText}`;
}

function compactStateForPrompt(state: BattleState) {
  return {
    phase: state.phase,
    status: state.status,
    opponentName: state.opponentName,
    turn: state.turn,
    activeOwn: state.activeOwn,
    activeOpponent: state.activeOpponent,
    field: state.field,
    opponentTeam: state.opponentTeam.map((pokemon) => compactPokemonForPrompt(pokemon, "opponent")),
    ownTeam: state.ownTeam.map((pokemon) => compactPokemonForPrompt(pokemon, "own")),
    latestMemo: state.latestMemo
  };
}

function hasGroundImmunity(pokemon: { types: string[]; abilities: Record<string, string> }): boolean {
  return pokemon.types.includes("Flying") || Object.values(pokemon.abilities).includes("Levitate");
}

function describePokemonData(store: LocalDataStore, name: string): string | null {
  const pokemon = store.getPokemon(name);
  if (!pokemon) return null;
  const displayName = pokemon.aliasesJa[0] ?? pokemon.name;
  const abilities = Object.values(pokemon.abilities).join(" / ") || "不明";
  const groundNote = hasGroundImmunity(pokemon)
    ? "じめん無効の可能性あり"
    : "じめん無効ではない";
  return `- ${displayName}: types=${pokemon.types.join("/")}; abilities=${abilities}; baseStats=${JSON.stringify(
    pokemon.baseStats
  )}; maxUnboostedSpeed=${maxUnboostedSpeed(pokemon)}; ${groundNote}`;
}

function relevantPokemonNames(state: BattleState, facts: BattleFacts): string[] {
  const names = new Set<string>();
  for (const name of [
    ...facts.opponentMentionedPokemon,
    ...facts.opponentSelectedPokemon,
    ...facts.ownMentionedPokemon,
    ...facts.ownSelectedPokemon,
    ...facts.faintedPokemon.map((pokemon) => pokemon.pokemon),
    facts.activeOwn,
    facts.activeOpponent,
    state.activeOwn,
    state.activeOpponent,
    ...state.opponentTeam.filter((pokemon) => pokemon.name).map((pokemon) => pokemon.name),
    ...state.ownTeam.filter((pokemon) => pokemon.name && (pokemon.selected || pokemon.active)).map((pokemon) => pokemon.name)
  ]) {
    if (name) names.add(name);
  }
  return [...names].slice(0, 12);
}

function opponentPokemonNames(state: BattleState, facts: BattleFacts): string[] {
  const names = new Set<string>();
  for (const name of [
    ...facts.opponentMentionedPokemon,
    ...facts.opponentSelectedPokemon,
    ...facts.faintedPokemon.filter((pokemon) => pokemon.side === "opponent").map((pokemon) => pokemon.pokemon),
    facts.activeOpponent,
    state.activeOpponent,
    ...state.opponentTeam.filter((pokemon) => pokemon.name).map((pokemon) => pokemon.name)
  ]) {
    if (name) names.add(name);
  }
  return [...names].slice(0, 12);
}

function readPokemonKnowledge(championsDataDir: string, store: LocalDataStore, pokemonName: string): string | null {
  const id = store.resolvePokemonId(pokemonName);
  if (!id) return null;
  const file = path.resolve(championsDataDir, "..", "knowledge", "pokemon", `${id}.md`);
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, "utf8").trim();
  if (!content) return null;
  const pokemon = store.getPokemon(pokemonName);
  const displayName = pokemon?.aliasesJa[0] ?? pokemonName;
  return `### ${displayName}（適用対象: ${displayName} の型・行動・対面リスクのみ。他のポケモンには転用しない）\n${limitText(content, 1600)}`;
}

export function buildLocalKnowledge(
  store: LocalDataStore,
  state: BattleState,
  facts: BattleFacts,
  championsDataDir: string
): string {
  const relevantNames = relevantPokemonNames(state, facts);
  const opponentNames = opponentPokemonNames(state, facts);
  const lines = relevantNames.flatMap((name) => {
    const description = describePokemonData(store, name);
    return description ? [description] : [];
  });
  const speedLines = relevantNames.flatMap((name) => {
    const description = describeSpeedData(store, state, name);
    return description ? [description] : [];
  });
  const knowledgeNotes = opponentNames.flatMap((name) => {
    const note = readPokemonKnowledge(championsDataDir, store, name);
    return note ? [note] : [];
  });
  return [
    "## この相談で参照すべきローカルポケモンデータ",
    ...(lines.length > 0 ? lines : ["なし"]),
    "",
    "## 素早さ比較用データ",
    ...(speedLines.length > 0 ? speedLines : ["なし"]),
    "",
    "## 相手パーティに紐づくポケモン別ナレッジ（各見出しのポケモン専用）",
    ...(knowledgeNotes.length > 0 ? knowledgeNotes : ["なし"])
  ].join("\n");
}

function normalizeNameArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const object = entry as Record<string, unknown>;
        for (const key of ["name", "pokemon", "value"]) {
          if (typeof object[key] === "string") return object[key] as string;
        }
      }
      return "";
    })
    .filter((entry) => entry.trim().length > 0);
}

function normalizeSidePokemonArray(value: unknown, fallbackSide: "own" | "opponent"): Array<{ side: "own" | "opponent"; pokemon: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ side: fallbackSide, pokemon: entry.trim() }];
    }
    if (!entry || typeof entry !== "object") return [];
    const object = entry as Record<string, unknown>;
    const pokemon =
      typeof object.pokemon === "string"
        ? object.pokemon
        : typeof object.name === "string"
          ? object.name
          : typeof object.value === "string"
            ? object.value
            : "";
    if (!pokemon.trim()) return [];
    const side = object.side === "own" || object.side === "opponent" ? object.side : fallbackSide;
    return [{ side, pokemon: pokemon.trim() }];
  });
}

function normalizeBattleFactsInput(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return {
    ...object,
    opponentName: typeof object.opponentName === "string" ? object.opponentName.trim() : undefined,
    opponentMentionedPokemon: normalizeNameArray(object.opponentMentionedPokemon),
    opponentSelectedPokemon: normalizeNameArray(object.opponentSelectedPokemon),
    ownMentionedPokemon: normalizeNameArray(object.ownMentionedPokemon),
    ownSelectedPokemon: normalizeNameArray(object.ownSelectedPokemon),
    field:
      typeof object.field === "string"
        ? object.field.trim()
        : Array.isArray(object.field)
          ? object.field
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
              .join(" / ")
          : undefined,
    statChanges: normalizeStatChangesArray(object.statChanges),
    faintedPokemon: normalizeSidePokemonArray(object.faintedPokemon, "opponent")
  };
}

function normalizeStatChangesArray(value: unknown): Array<{ side: "own" | "opponent"; pokemon: string; changes: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const object = entry as Record<string, unknown>;
    const pokemon =
      typeof object.pokemon === "string"
        ? object.pokemon
        : typeof object.name === "string"
          ? object.name
          : typeof object.value === "string"
            ? object.value
            : "";
    const changes =
      typeof object.changes === "string"
        ? object.changes
        : typeof object.statChanges === "string"
          ? object.statChanges
          : typeof object.change === "string"
            ? object.change
            : "";
    const side = object.side === "own" || object.side === "opponent" ? object.side : "opponent";
    if (!pokemon.trim() || !changes.trim()) return [];
    return [{ side, pokemon: pokemon.trim(), changes: changes.trim() }];
  });
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter((name) => name.trim().length > 0))];
}

function pokemonNameKey(name: string): string {
  return name
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[・\s._'’`´-]/g, "")
    .replace(/ー/g, "");
}

function samePokemonName(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || pokemonNameKey(left) === pokemonNameKey(right);
}

function mentionedOwnNamesFromText(state: BattleState, transcript: string): string[] {
  return state.ownTeam
    .map((pokemon) => pokemon.name)
    .filter((name) => name && transcript.includes(name));
}

function mentionedOpponentNamesFromText(state: BattleState, transcript: string): string[] {
  const ownNames = new Set(state.ownTeam.map((pokemon) => pokemon.name));
  return state.opponentTeam
    .map((pokemon) => pokemon.name)
    .filter((name) => name && !ownNames.has(name) && transcript.includes(name));
}

function isOpponentPartyListText(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, "");
  return /(相手|お相手).*(ポケモン|手持ち|パーティ|6体|六体)|見せ合い|相手.*6体|ポケモン.*6体/.test(normalized);
}

export function inferOpponentPartyPokemonFromText(store: LocalDataStore, transcript: string): string[] {
  if (!isOpponentPartyListText(transcript)) return [];
  const matches: Array<{ name: string; index: number }> = [];
  for (const pokemon of store.listPokemon()) {
    const names = [pokemon.name, ...pokemon.aliasesJa]
      .filter((name) => name.trim().length >= 2)
      .sort((a, b) => b.length - a.length);
    const matchedName = names.find((name) => transcript.includes(name));
    if (matchedName) matches.push({ name: pokemon.aliasesJa[0] ?? matchedName, index: transcript.indexOf(matchedName) });
  }
  return uniqueNames(matches.sort((a, b) => a.index - b.index).map((match) => match.name));
}

function addTranscriptMentionedPokemon(facts: BattleFacts, state: BattleState, transcript: string, store: LocalDataStore): BattleFacts {
  const ownMentioned = mentionedOwnNamesFromText(state, transcript);
  const opponentMentioned = mentionedOpponentNamesFromText(state, transcript);
  const opponentPartyMentioned = inferOpponentPartyPokemonFromText(store, transcript);
  const activeOwn = facts.activeOwn || inferActiveOwnFromTranscript(state, transcript);
  if (ownMentioned.length === 0 && opponentMentioned.length === 0 && opponentPartyMentioned.length === 0 && !activeOwn) return facts;
  const ownSet = new Set(ownMentioned);
  const keepOwnNamesAsOpponent = new Set(opponentPartyMentioned);
  return {
    ...facts,
    activeOwn,
    ownMentionedPokemon: uniqueNames([...facts.ownMentionedPokemon, ...ownMentioned]),
    opponentMentionedPokemon: uniqueNames([
      ...facts.opponentMentionedPokemon.filter((name) => !ownSet.has(name) || keepOwnNamesAsOpponent.has(name)),
      ...opponentMentioned,
      ...opponentPartyMentioned
    ])
  };
}

function isSurvivalItemText(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, "");
  const itemMentioned = /(きあい|気合い?|気合)の?(タスキ|襷|ハチマキ|鉢巻き?|はちまき)/.test(normalized);
  const survived = /(持ちこた|耐え|こらえ|HP.?1|1.?残)/.test(normalized);
  return itemMentioned && survived;
}

function survivalItemName(transcript: string): string {
  return /ハチマキ|鉢巻|はちまき/.test(transcript) ? "きあいのハチマキ" : "きあいのタスキ";
}

function inferOpponentSurvivalTarget(state: BattleState, facts: BattleFacts, transcript: string): string | undefined {
  const candidates = [
    facts.activeOpponent,
    state.activeOpponent,
    ...facts.opponentSelectedPokemon,
    ...facts.opponentMentionedPokemon,
    ...state.opponentTeam.filter((pokemon) => pokemon.selected || pokemon.active).map((pokemon) => pokemon.name)
  ].filter((name): name is string => Boolean(name));
  return candidates.find((name) => transcript.includes(name)) ?? facts.activeOpponent ?? state.activeOpponent ?? candidates[0];
}

function applyOpponentSurvivalItemFacts(facts: BattleFacts, transcript: string, state: BattleState): BattleFacts {
  if (!isSurvivalItemText(transcript)) return facts;
  const pokemon = inferOpponentSurvivalTarget(state, facts, transcript);
  if (!pokemon) return facts;
  const item = survivalItemName(transcript);
  const hpUpdates = [
    ...facts.hpUpdates.filter((update) => !(update.side === "opponent" && update.pokemon === pokemon)),
    { side: "opponent" as const, pokemon, hpPercent: 1 }
  ];
  const revealedItem = facts.revealedItem.some((entry) => entry.pokemon === pokemon && entry.item === item)
    ? facts.revealedItem
    : [...facts.revealedItem, { pokemon, item, certainty: "confirmed" as const }];
  const notes = facts.notes.some((note) => note.includes("持ちこたえ"))
    ? facts.notes
    : [...facts.notes, `${pokemon}は${item}で持ちこたえたためHP1。`];
  return { ...facts, hpUpdates, revealedItem, notes };
}

function applyLikelyOwnMoveDamageHpFacts(facts: BattleFacts, transcript: string, state: BattleState): BattleFacts {
  const normalized = transcript.normalize("NFKC").replace(/\s+/g, "");
  const match = normalized.match(/(?:じしん|地震|自身)で(?:[^。]*?)(\d{1,3})%まで(?:削|けず)/);
  if (!match) return facts;
  const hpPercent = Math.max(0, Math.min(100, Number(match[1])));
  const activeOpponent = facts.activeOpponent || state.activeOpponent;
  if (!activeOpponent || Number.isNaN(hpPercent)) return facts;
  const activeOwn = facts.activeOwn || state.activeOwn;
  const hpUpdates = [
    ...facts.hpUpdates.filter((update) =>
      !(
        update.hpPercent === hpPercent &&
        ((update.side === "own" && update.pokemon === activeOwn) ||
          (update.side === "opponent" && update.pokemon === activeOpponent))
      )
    ),
    { side: "opponent" as const, pokemon: activeOpponent, hpPercent }
  ];
  return { ...facts, hpUpdates };
}

function appendUniqueStatChange(
  changes: BattleFacts["statChanges"],
  entry: BattleFacts["statChanges"][number]
): BattleFacts["statChanges"] {
  return changes.some((change) =>
    change.side === entry.side && change.pokemon === entry.pokemon && change.changes === entry.changes
  )
    ? changes
    : [...changes, entry];
}

function appendUniqueRevealedMove(
  moves: BattleFacts["revealedMoves"],
  entry: BattleFacts["revealedMoves"][number]
): BattleFacts["revealedMoves"] {
  return moves.some((move) => move.pokemon === entry.pokemon && move.move === entry.move)
    ? moves
    : [...moves, entry];
}

function mergeConditionText(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) return current;
  if (!current.trim()) return next;
  if (current.includes(next)) return current;
  return `${current} / ${next}`;
}

function compactLookupKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[・\s._'-]/g, "");
}

function moveNamesForText(move: LocalMove): string[] {
  return [move.name, ...move.aliasesJa].filter((name) => name.trim().length > 0);
}

function transcriptMentionsMove(transcript: string, move: LocalMove): boolean {
  const normalized = compactLookupKey(transcript);
  return moveNamesForText(move).some((name) => normalized.includes(compactLookupKey(name)));
}

function transcriptImpliesMoveUsed(transcript: string, move: LocalMove, userName: string): boolean {
  if (!transcriptMentionsMove(transcript, move)) return false;
  if (userName && transcript.includes(`${userName}の`)) return true;
  if (userName && transcript.includes(`${userName}は`) && /(使|撃|打|選|せんたく)/.test(transcript)) return true;
  return /(使|撃|打|受け|受けた|くら|喰ら|減ら|通|耐え|倒|押|選|せんたく)/.test(transcript);
}

function inferMoveUserSide(state: BattleState, userName: string): "own" | "opponent" {
  return isOwnPokemon(state, userName) ? "own" : "opponent";
}

function moveEffectTarget(move: LocalMove, userSide: "own" | "opponent", selfTarget: boolean): "own" | "opponent" {
  if (selfTarget || move.target === "self") return userSide;
  return userSide === "own" ? "opponent" : "own";
}

function activePokemonForSide(state: BattleState, facts: BattleFacts, side: "own" | "opponent"): string | undefined {
  return side === "own"
    ? facts.activeOwn || state.activeOwn
    : facts.activeOpponent || state.activeOpponent;
}

const statLabelByKey: Record<keyof StatBoosts, string> = {
  atk: "攻撃",
  def: "防御",
  spa: "特攻",
  spd: "特防",
  spe: "素早さ",
  accuracy: "命中",
  evasion: "回避率"
};

const conditionByStatus: Record<string, string> = {
  brn: "やけど",
  par: "まひ",
  slp: "ねむり",
  frz: "こおり",
  psn: "どく",
  tox: "もうどく",
  yawn: "あくび"
};

function statChangeText(stat: keyof StatBoosts, stage: number): string | null {
  if (!stage) return null;
  const label = statLabelByKey[stat];
  if (!label) return null;
  return `${label}${stage > 0 ? `+${stage}` : stage}`;
}

function applyBoostsToFacts(
  facts: BattleFacts,
  state: BattleState,
  move: LocalMove,
  userSide: "own" | "opponent",
  boosts: StatBoosts | undefined,
  selfTarget: boolean,
  notes: string[]
): BattleFacts {
  if (!boosts || Object.keys(boosts).length === 0) return facts;
  const targetSide = moveEffectTarget(move, userSide, selfTarget);
  const targetPokemon = activePokemonForSide(state, facts, targetSide);
  if (!targetPokemon) return facts;
  let next = facts;
  for (const [stat, stage] of Object.entries(boosts) as Array<[keyof StatBoosts, number]>) {
    const changes = statChangeText(stat, stage);
    if (!changes) continue;
    next = {
      ...next,
      statChanges: appendUniqueStatChange(next.statChanges, {
        side: targetSide,
        pokemon: targetPokemon,
        changes
      })
    };
    notes.push(`${targetPokemon}の${changes}`);
  }
  return next;
}

function applyStatusToFacts(
  facts: BattleFacts,
  state: BattleState,
  move: LocalMove,
  userSide: "own" | "opponent",
  status: string | undefined,
  selfTarget: boolean,
  notes: string[]
): BattleFacts {
  if (!status) return facts;
  const condition = conditionByStatus[status] ?? status;
  const targetSide = moveEffectTarget(move, userSide, selfTarget);
  const targetPokemon = activePokemonForSide(state, facts, targetSide);
  if (!targetPokemon) return facts;
  const userPokemon = activePokemonForSide(state, facts, userSide);
  const statuses = facts.statuses.filter((entry) =>
    !(targetSide !== userSide && entry.side === userSide && entry.pokemon === userPokemon && entry.condition === condition)
  );
  notes.push(`${targetPokemon}は${condition}`);
  return {
    ...facts,
    statuses: statuses.some((entry) => entry.side === targetSide && entry.pokemon === targetPokemon && entry.condition === condition)
      ? statuses
      : [...statuses, { side: targetSide, pokemon: targetPokemon, condition }]
  };
}

function moveGuaranteedEffects(move: LocalMove): Array<{ boosts?: StatBoosts; status?: string; selfTarget: boolean }> {
  const effects: Array<{ boosts?: StatBoosts; status?: string; selfTarget: boolean }> = [];
  const directStatus = move.status ?? move.volatileStatus ?? undefined;
  if (move.boosts) effects.push({ boosts: move.boosts, status: directStatus, selfTarget: move.target === "self" });
  if (move.self?.boosts) effects.push({ boosts: move.self.boosts, selfTarget: true });
  if (directStatus && !move.boosts) effects.push({ status: directStatus, selfTarget: move.target === "self" });
  const secondaries = [
    ...(move.secondary ? [move.secondary] : []),
    ...(move.secondaries ?? [])
  ];
  for (const secondary of secondaries) {
    if (secondary.chance !== 100) continue;
    const secondaryStatus = secondary.status ?? secondary.volatileStatus;
    if (secondary.boosts || secondaryStatus) {
      effects.push({ boosts: secondary.boosts, status: secondaryStatus, selfTarget: false });
    }
    if (secondary.self?.boosts) {
      effects.push({ boosts: secondary.self.boosts, selfTarget: true });
    }
  }
  return effects;
}

function inferredMoveUses(store: LocalDataStore, facts: BattleFacts, transcript: string, state: BattleState): Array<{ user: string; move: LocalMove }> {
  const uses = facts.revealedMoves.flatMap((entry) => {
    const move = store.getMove(entry.move);
    return move && transcriptImpliesMoveUsed(transcript, move, entry.pokemon) ? [{ user: entry.pokemon, move }] : [];
  });
  const activeOwn = facts.activeOwn || state.activeOwn;
  const activeOpponent = facts.activeOpponent || state.activeOpponent;
  for (const move of store.listMoves()) {
    if (!transcriptMentionsMove(transcript, move)) continue;
    if (activeOpponent && (transcript.includes(`${activeOpponent}の`) || (transcript.includes(`${activeOpponent}は`) && /(?:使|撃|打|選|せんたく)/.test(transcript)) || /(?:相手|敵)[^。]*?(?:使|撃|打|受け|減ら|通|耐え|倒|押|選|せんたく)/.test(transcript))) {
      uses.push({ user: activeOpponent, move });
    } else if (activeOwn && (transcript.includes(`${activeOwn}の`) || (transcript.includes(`${activeOwn}は`) && /(?:使|撃|打|選|せんたく)/.test(transcript)) || /(?:こちら|自分|味方)[^。]*?(?:使|撃|打|受け|減ら|通|耐え|倒|押|選|せんたく)/.test(transcript))) {
      uses.push({ user: activeOwn, move });
    }
  }
  const seen = new Set<string>();
  return uses.filter((use) => {
    const key = `${use.user}:${use.move.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return moveGuaranteedEffects(use.move).length > 0;
  });
}

export function applyKnownMoveSideEffectFacts(
  facts: BattleFacts,
  transcript: string,
  state: BattleState,
  store: LocalDataStore
): BattleFacts {
  let next = applyLikelyOwnMoveDamageHpFacts(facts, transcript, state);
  const notes: string[] = [];
  for (const use of inferredMoveUses(store, facts, transcript, state)) {
    const userSide = inferMoveUserSide(state, use.user);
    next = {
      ...next,
      revealedMoves: appendUniqueRevealedMove(next.revealedMoves, {
        pokemon: use.user,
        move: use.move.aliasesJa[0] ?? use.move.name,
        certainty: "confirmed"
      })
    };
    for (const effect of moveGuaranteedEffects(use.move)) {
      next = applyBoostsToFacts(next, state, use.move, userSide, effect.boosts, effect.selfTarget, notes);
      next = applyStatusToFacts(next, state, use.move, userSide, effect.status, effect.selfTarget, notes);
    }
  }
  if (notes.length === 0) return next;
  const uniqueNotes = [...new Set(notes)].map((note) => `${note}。`);
  return {
    ...next,
    notes: [...next.notes, ...uniqueNotes.filter((note) => !next.notes.includes(note))]
  };
}

function statusFromCertainty(certainty: "suspected" | "confirmed"): KnownValue["status"] {
  return certainty === "confirmed" ? "confirmed" : "suspected";
}

function canonicalPokemonName(store: LocalDataStore, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const megaEvolution = inferMegaEvolution(store, name);
  if (megaEvolution) return megaEvolution.megaName;
  const pokemon = store.getPokemon(name);
  return pokemon?.aliasesJa[0] ?? name;
}

function canonicalMoveName(store: LocalDataStore, name: string): string {
  const move = store.getMove(name);
  return move?.aliasesJa[0] ?? name;
}

function canonicalizeBattleFacts(facts: BattleFacts, store: LocalDataStore): BattleFacts {
  const pokemonName = (name: string) => canonicalPokemonName(store, name) ?? name;
  return {
    ...facts,
    opponentMentionedPokemon: facts.opponentMentionedPokemon.map(pokemonName),
    opponentSelectedPokemon: facts.opponentSelectedPokemon.map(pokemonName),
    ownMentionedPokemon: facts.ownMentionedPokemon.map(pokemonName),
    ownSelectedPokemon: facts.ownSelectedPokemon.map(pokemonName),
    statChanges: facts.statChanges.map((change) => ({ ...change, pokemon: pokemonName(change.pokemon) })),
    activeOwn: canonicalPokemonName(store, facts.activeOwn),
    activeOpponent: canonicalPokemonName(store, facts.activeOpponent),
    hpUpdates: facts.hpUpdates.map((update) => ({ ...update, pokemon: pokemonName(update.pokemon) })),
    faintedPokemon: facts.faintedPokemon.map((fainted) => ({ ...fainted, pokemon: pokemonName(fainted.pokemon) })),
    statuses: facts.statuses.map((status) => ({ ...status, pokemon: pokemonName(status.pokemon) })),
    revealedMoves: facts.revealedMoves.map((move) => ({
      ...move,
      pokemon: pokemonName(move.pokemon),
      move: canonicalMoveName(store, move.move)
    })),
    revealedAbility: facts.revealedAbility.map((ability) => ({
      ...ability,
      pokemon: pokemonName(ability.pokemon)
    })),
    revealedItem: facts.revealedItem.map((item) => ({ ...item, pokemon: pokemonName(item.pokemon) })),
    damageCalcRequests: facts.damageCalcRequests.map((request) => ({
      ...request,
      attacker: canonicalPokemonName(store, request.attacker),
      defender: canonicalPokemonName(store, request.defender),
      move: request.move ? canonicalMoveName(store, request.move) : undefined
    }))
  };
}

function isOwnPokemon(state: BattleState, name: string): boolean {
  return state.ownTeam.some((pokemon) => pokemon.name === name);
}

function detectFactsAnomalies(
  updatedState: BattleState,
  facts: BattleFacts,
  resolvedNames: Record<string, string | null>
): string[] {
  const warnings: string[] = [];
  if (facts.opponentSelectedPokemon.length > 3) {
    warnings.push(`opponentSelectedPokemonが3体を超えて抽出されました: ${facts.opponentSelectedPokemon.join(", ")}`);
  }
  const knownNames = new Set([
    ...updatedState.ownTeam.map((pokemon) => pokemon.name),
    ...updatedState.opponentTeam.map((pokemon) => pokemon.name)
  ]);
  const droppedUpdateTargets = uniqueNames(
    [
      ...facts.revealedMoves.map((entry) => entry.pokemon),
      ...facts.revealedAbility.map((entry) => entry.pokemon),
      ...facts.revealedItem.map((entry) => entry.pokemon),
      ...facts.statChanges.map((entry) => entry.pokemon),
      ...facts.statuses.map((entry) => entry.pokemon),
      ...facts.faintedPokemon.map((entry) => entry.pokemon),
      ...facts.hpUpdates.map((entry) => entry.pokemon)
    ].filter((name) => !knownNames.has(name))
  );
  if (droppedUpdateTargets.length > 0) {
    warnings.push(
      `facts抽出結果のポケモン名がstate上のどちらのチームにも一致せず、更新が反映されなかった可能性があります: ${droppedUpdateTargets.join(", ")}`
    );
  }
  const unresolvedNames = uniqueNames(
    Object.entries(resolvedNames)
      .filter(([, id]) => id === null)
      .map(([name]) => name)
  );
  if (unresolvedNames.length > 0) {
    warnings.push(`ローカルデータ(ポケモン/技)で名前解決できなかった単語があります: ${unresolvedNames.join(", ")}`);
  }
  return warnings;
}

function findPokemon(team: PokemonState[], name: string): PokemonState | undefined {
  return team.find((pokemon) => pokemon.name === name || pokemon.id === name) ??
    team.find((pokemon) => samePokemonName(pokemon.name, name));
}

function ownsMove(pokemon: PokemonState, command: string): boolean {
  const normalizedCommand = command.trim();
  return pokemon.moves.some((move) => move.value === normalizedCommand);
}

function findOwnMoveOwner(state: BattleState, command: string): PokemonState | undefined {
  return state.ownTeam.find((pokemon) => ownsMove(pokemon, command));
}

function firstOwnNameInText(state: BattleState, text: string): string | undefined {
  const matches = state.ownTeam
    .map((pokemon) => ({ name: pokemon.name, index: text.indexOf(pokemon.name) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  return matches[0]?.name;
}

function inferActiveOwnFromTranscript(state: BattleState, transcript: string): string | undefined {
  if (isOpponentPartyListText(transcript)) return undefined;
  const normalized = transcript.replace(/\s+/g, "");
  const candidates = state.ownTeam.filter((pokemon) => pokemon.selected || pokemon.active);
  const contextualMatches = candidates.filter((pokemon) => {
    const name = pokemon.name;
    if (!name || !normalized.includes(name)) return false;
    return [
      new RegExp(`(?:場|場には|場は|今|現在|こちらは|自分は)[^。！？?]*${name}`),
      new RegExp(`${name}[^。！？?]*(?:場にいる|場にいます|出しました|出します|出ています|出して|交換しました|交代しました|投げました)`),
      new RegExp(`${name}(?:は|で)?(?:何を|どうすれば|どうしたら)`)
    ].some((pattern) => pattern.test(normalized));
  });
  return contextualMatches.length === 1 ? contextualMatches[0].name : undefined;
}

function getActiveOwnPokemon(state: BattleState): PokemonState | undefined {
  return (
    findPokemon(state.ownTeam, state.activeOwn) ??
    state.ownTeam.find((pokemon) => pokemon.active)
  );
}

function inferActiveOwnName(state: BattleState, facts: BattleFacts): string | undefined {
  if (facts.activeOwn && findPokemon(state.ownTeam, facts.activeOwn)) return facts.activeOwn;
  if (state.activeOwn && findPokemon(state.ownTeam, state.activeOwn)) return state.activeOwn;
  for (const entry of [...state.history].reverse()) {
    const moveOwner = findOwnMoveOwner(state, entry.action);
    if (moveOwner?.name) return moveOwner.name;
    const actionMention = firstOwnNameInText(state, entry.action);
    if (actionMention) return actionMention;
    const transcriptMention = firstOwnNameInText(state, entry.transcript);
    if (transcriptMention) return transcriptMention;
  }
  const selectedFact = facts.ownSelectedPokemon.find((name) => findPokemon(state.ownTeam, name));
  if (selectedFact) return selectedFact;
  return state.ownTeam.find((pokemon) => pokemon.selected)?.name;
}

function activateOwnPokemon(state: BattleState, activeOwn: string): BattleState {
  if (!findPokemon(state.ownTeam, activeOwn)) return state;
  return {
    ...state,
    activeOwn,
    ownTeam: state.ownTeam.map((pokemon) => ({ ...pokemon, active: pokemon.name === activeOwn }))
  };
}

function isValidActiveMoveCandidate(state: BattleState, candidate: CandidateAction): boolean {
  if (candidate.kind !== "move") return true;
  const active = getActiveOwnPokemon(state);
  return Boolean(active && ownsMove(active, candidate.command));
}

function isValidActiveSwitchCandidate(state: BattleState, candidate: CandidateAction): boolean {
  if (candidate.kind !== "switch") return true;
  const active = getActiveOwnPokemon(state);
  const target = findPokemon(state.ownTeam, candidate.command);
  return Boolean(target && target.selected && target.name !== active?.name && isBattleReadyPokemon(target));
}

function isValidBattleCandidate(state: BattleState, candidate: CandidateAction): boolean {
  return isValidActiveMoveCandidate(state, candidate) && isValidActiveSwitchCandidate(state, candidate);
}

function isBattleReadyPokemon(pokemon: PokemonState): boolean {
  return pokemon.hpPercent !== 0 && pokemon.condition !== "ひんし";
}

function hasActiveBattleReadyOwnPokemon(state: BattleState): boolean {
  const active = getActiveOwnPokemon(state);
  return Boolean(active && isBattleReadyPokemon(active));
}

function selectedBenchPokemon(state: BattleState): PokemonState[] {
  const active = getActiveOwnPokemon(state);
  return state.ownTeam.filter(
    (pokemon) => pokemon.selected && pokemon.name !== active?.name && isBattleReadyPokemon(pokemon)
  );
}

export function localReplacementCandidates(state: BattleState): CandidateAction[] {
  if (state.phase !== "battle" || state.status !== "active" || hasActiveBattleReadyOwnPokemon(state)) return [];
  return state.ownTeam
    .filter((pokemon) => pokemon.selected && isBattleReadyPokemon(pokemon))
    .map((pokemon) => ({
      kind: "switch" as const,
      command: pokemon.name,
      reason: `場のポケモンが不在またはひんしのため、控えでまだ動ける${pokemon.name}を出します。`,
      risk: "相手の次の技や交代先によって受け出し負荷は変わります。",
      confidence: "medium" as const
    }));
}

function firstDamageAssumption(
  store: LocalDataStore,
  attacker: PokemonState,
  defender: string,
  state?: BattleState
): { move: string; percentMin: number; percentMax: number } | null {
  const profile = parseStatProfile(attacker.notes);
  const attackerName = battlePokemonNameForCalc(store, attacker);
  let best: { move: string; percentMin: number; percentMax: number } | null = null;
  for (const move of attacker.moves) {
    if (!move.value) continue;
    try {
      const result = calculateLocalDamage(store, {
        attacker: attackerName,
        defender,
        move: move.value,
        attackerStatPoints: profile.statPoints,
        attackerNature: profile.nature
      });
      const first = result.assumptions[0];
      if (!first) continue;
      const localMove = store.getMove(move.value);
      if (!localMove) continue;
      const adjusted = adjustDamagePercentForBattleState(first.percentMin, first.percentMax, state, attacker, localMove);
      const summary = {
        move: move.value,
        percentMin: adjusted.percentMin,
        percentMax: adjusted.percentMax
      };
      if (!best || summary.percentMax > best.percentMax) best = summary;
    } catch {
      // Status moves or unresolved local data are not useful for this quick switch comparison.
    }
  }
  return best;
}

function activeOpponentPokemon(state: BattleState): PokemonState | undefined {
  return findPokemon(state.opponentTeam, state.activeOpponent) ??
    state.opponentTeam.find((pokemon) => pokemon.active);
}

function moveMatchupText(matchup: MoveMatchup): string {
  const effectivenessText =
    matchup.effectiveness === 0
      ? "無効"
      : matchup.effectiveness > 1
        ? `${matchup.effectiveness}倍`
        : matchup.effectiveness < 1
          ? `${matchup.effectiveness}倍に軽減`
          : "等倍";
  const speedText =
    matchup.userMovesFirstBySpeed === true
      ? "素早さではこちらが先手想定"
      : matchup.userMovesFirstBySpeed === false
        ? "素早さでは後手想定"
        : "素早さは未確定";
  return `${matchup.move}は${matchup.defender}に${effectivenessText}、概算${matchup.percentMin}-${matchup.percentMax}%、${speedText}です。`;
}

function stageMultiplier(stage: number): number {
  const clamped = Math.max(-6, Math.min(6, stage));
  return clamped >= 0 ? (2 + clamped) / 2 : 2 / (2 - clamped);
}

function parseBattleStatStage(statChanges: string, stat: "atk" | "spa"): number {
  const normalized = statChanges.normalize("NFKC");
  const patterns =
    stat === "atk"
      ? [/(?:こうげき|攻撃|Atk|A)[^+\-0-9]*([+\-][0-6])/i]
      : [/(?:とくこう|特攻|特こう|SpA|C)[^+\-0-9]*([+\-][0-6])/i];
  for (const pattern of patterns) {
    const explicit = normalized.match(pattern);
    if (explicit) return Number(explicit[1]);
  }
  return 0;
}

function fieldSideHasEffect(field: string, side: "own" | "opponent", effect: string): boolean {
  const normalized = field.normalize("NFKC");
  if (!normalized.includes(effect)) return false;
  const sidePattern = side === "own" ? "(?:自分|こちら|味方|自軍)" : "(?:相手|敵)";
  const matcher = new RegExp(
    `(?:${sidePattern})(?:側)?[^。/、,]*${effect}|${effect}[^。/、,]*(?:${sidePattern})(?:側)?`,
    "i"
  );
  return matcher.test(normalized);
}

function damageAdjustmentNotes(state: BattleState | undefined, attacker: PokemonState, move: LocalMove): string[] {
  if (!state) return [];
  const notes: string[] = [];
  const attackStage = parseBattleStatStage(attacker.statChanges ?? "", move.category === "Physical" ? "atk" : "spa");
  if (attackStage !== 0) {
    notes.push(`${move.category === "Physical" ? "攻撃" : "特攻"}${attackStage > 0 ? `+${attackStage}` : attackStage}`);
  }
  if (move.category === "Physical" && fieldSideHasEffect(state.field, "opponent", "リフレクター")) {
    notes.push("相手側リフレクター");
  }
  if (move.category === "Special" && fieldSideHasEffect(state.field, "opponent", "ひかりのかべ")) {
    notes.push("相手側ひかりのかべ");
  }
  return notes;
}

function adjustDamagePercentForBattleState(
  percentMin: number,
  percentMax: number,
  state: BattleState | undefined,
  attacker: PokemonState,
  move: LocalMove
): { percentMin: number; percentMax: number; notes: string[] } {
  if (!state) return { percentMin, percentMax, notes: [] };
  const attackStage = parseBattleStatStage(attacker.statChanges ?? "", move.category === "Physical" ? "atk" : "spa");
  let multiplier = stageMultiplier(attackStage);
  if (move.category === "Physical" && fieldSideHasEffect(state.field, "opponent", "リフレクター")) {
    multiplier *= 0.5;
  }
  if (move.category === "Special" && fieldSideHasEffect(state.field, "opponent", "ひかりのかべ")) {
    multiplier *= 0.5;
  }
  const notes = damageAdjustmentNotes(state, attacker, move);
  return {
    percentMin: Number((percentMin * multiplier).toFixed(1)),
    percentMax: Number((percentMax * multiplier).toFixed(1)),
    notes
  };
}

function moveMatchupForActiveMove(
  store: LocalDataStore,
  state: BattleState,
  moveName: string
): MoveMatchup | null {
  const attacker = getActiveOwnPokemon(state);
  const defender = activeOpponentPokemon(state);
  if (!attacker || !defender || !state.activeOpponent) return null;
  const move = store.getMove(moveName);
  const defenderLocal = localPokemonForName(store, defender.name || state.activeOpponent);
  if (!move || !defenderLocal || move.category === "Status" || move.basePower <= 0) return null;
  const profile = parseStatProfile(attacker.notes);
  const attackerName = battlePokemonNameForCalc(store, attacker);
  try {
    const result = calculateLocalDamage(store, {
      attacker: attackerName,
      defender: defender.name || state.activeOpponent,
      move: moveName,
      attackerStatPoints: profile.statPoints,
      attackerNature: profile.nature
    });
    const first = result.assumptions[0];
    if (!first) return null;
    const adjustedDamage = adjustDamagePercentForBattleState(first.percentMin, first.percentMax, state, attacker, move);
    const attackerSpeed = knownOwnSpeed(store, attacker);
    const targetLocal = localPokemonForName(store, defender.name || state.activeOpponent);
    const targetSpeed = targetLocal ? maxUnboostedSpeed(targetLocal) : null;
    const userEffectiveSpeed = attackerSpeed === null ? null : effectiveSpeed(attackerSpeed, state, attacker, "own");
    const targetEffectiveSpeed = targetSpeed === null ? null : effectiveSpeed(targetSpeed, state, defender, "opponent");
    const userMovesFirstBySpeed =
      userEffectiveSpeed === null || targetEffectiveSpeed === null
        ? null
        : userEffectiveSpeed >= targetEffectiveSpeed;
    const matchup: MoveMatchup = {
      attacker: attacker.name,
      defender: defender.name || state.activeOpponent,
      move: moveName,
      moveType: move.type,
      effectiveness: typeEffectiveness(move.type, defenderLocal.types),
      priority: move.priority,
      percentMin: adjustedDamage.percentMin,
      percentMax: adjustedDamage.percentMax,
      userEffectiveSpeed,
      targetEffectiveSpeed,
      userMovesFirstBySpeed,
      note: ""
    };
    const adjustmentText = adjustedDamage.notes.length > 0 ? `（${adjustedDamage.notes.join("、")}込み）` : "";
    return { ...matchup, note: `${moveMatchupText(matchup)}${adjustmentText}` };
  } catch {
    return null;
  }
}

export function localActiveMoveCandidates(store: LocalDataStore, state: BattleState): CandidateAction[] {
  if (state.phase !== "battle" || state.status !== "active") return [];
  const active = getActiveOwnPokemon(state);
  if (!active || !state.activeOpponent) return [];
  const opponent = activeOpponentPokemon(state);
  const opponentLowHp = (opponent?.hpPercent ?? 100) <= 15;
  return active.moves
    .flatMap((move) => {
      if (!move.value) return [];
      const matchup = moveMatchupForActiveMove(store, state, move.value);
      if (!matchup) return [];
      return [{
        kind: "move" as const,
        command: move.value,
        reason: `ローカル評価: ${matchup.note}`,
        risk: matchup.effectiveness < 1
          ? "半減以下のため、他に高い打点があるなら優先度を下げます。"
          : "相手の持ち物、積み技、交代で実ダメージは変動します。",
        confidence: matchup.effectiveness >= 1 && matchup.percentMax >= 50 ? "high" as const : "medium" as const,
        moveMatchup: matchup
      }];
    })
    .sort((left, right) =>
      (opponentLowHp ? (right.moveMatchup?.priority ?? 0) - (left.moveMatchup?.priority ?? 0) : 0) ||
      (right.moveMatchup?.percentMax ?? 0) - (left.moveMatchup?.percentMax ?? 0) ||
      (right.moveMatchup?.effectiveness ?? 0) - (left.moveMatchup?.effectiveness ?? 0) ||
      (right.moveMatchup?.priority ?? 0) - (left.moveMatchup?.priority ?? 0)
    );
}

function withMoveMatchups(store: LocalDataStore, state: BattleState, candidates: CandidateAction[]): CandidateAction[] {
  return candidates.map((candidate) => {
    if (candidate.kind !== "move" || hasCompleteMoveMatchup(candidate.moveMatchup)) return candidate;
    const matchup = moveMatchupForActiveMove(store, state, candidate.command);
    if (!matchup) {
      const { moveMatchup: _incompleteMoveMatchup, ...candidateWithoutMatchup } = candidate;
      return candidateWithoutMatchup;
    }
    return {
      ...candidate,
      reason: `${candidate.reason} / ローカル評価: ${matchup.note}`,
      moveMatchup: matchup
    };
  });
}

function withLocalMoveCandidates(store: LocalDataStore, state: BattleState, candidates: CandidateAction[]): CandidateAction[] {
  const localMoves = localActiveMoveCandidates(store, state);
  if (localMoves.length === 0) return candidates;
  const existingCommands = new Set(candidates.map((candidate) => `${candidate.kind}:${candidate.command}`));
  const additions = localMoves.filter((candidate) => !existingCommands.has(`${candidate.kind}:${candidate.command}`));
  return [...additions, ...candidates];
}

function withoutDominatedMoveCandidates(state: BattleState, candidates: CandidateAction[]): CandidateAction[] {
  const moveCandidates = candidates.filter(
    (candidate): candidate is CandidateAction & { moveMatchup: MoveMatchup } =>
      candidate.kind === "move" && hasCompleteMoveMatchup(candidate.moveMatchup)
  );
  if (moveCandidates.length <= 1) return candidates.slice(0, 5);
  const opponent = activeOpponentPokemon(state);
  const opponentLowHp = (opponent?.hpPercent ?? 100) <= 15;
  const bestPercentMax = Math.max(...moveCandidates.map((candidate) => candidate.moveMatchup.percentMax));
  const pruned = candidates.filter((candidate) => {
    if (candidate.kind !== "move" || !hasCompleteMoveMatchup(candidate.moveMatchup)) return true;
    const matchup = candidate.moveMatchup;
    if (matchup.effectiveness === 0) return false;
    const heavilyDominated = matchup.percentMax < bestPercentMax * 0.5;
    if (!heavilyDominated) return true;
    if (opponentLowHp && matchup.priority > 0) return true;
    if (matchup.priority > 0 && matchup.userMovesFirstBySpeed === false) return true;
    return false;
  });
  return (pruned.length > 0 ? pruned : candidates).slice(0, 5);
}

export function localSwitchCandidate(store: LocalDataStore, state: BattleState): CandidateAction | null {
  if (state.phase !== "battle" || state.status !== "active") return null;
  const activeOwn = getActiveOwnPokemon(state);
  if (!activeOwn || !state.activeOpponent) return null;
  const bench = selectedBenchPokemon(state);
  if (bench.length === 0) return null;

  const activeDamage = firstDamageAssumption(store, activeOwn, state.activeOpponent, state);
  const switchOptions = bench.flatMap((pokemon) => {
    const damage = firstDamageAssumption(store, pokemon, state.activeOpponent, state);
    return damage ? [{ pokemon, damage }] : [];
  });
  if (switchOptions.length === 0) return null;

  switchOptions.sort((left, right) => right.damage.percentMax - left.damage.percentMax);
  const best = switchOptions[0];
  const opponent = activeOpponentPokemon(state);
  const opponentHp = opponent?.hpPercent ?? null;
  if (
    activeDamage &&
    (
      activeDamage.percentMax >= 100 ||
      (opponentHp !== null && activeDamage.percentMin >= opponentHp)
    )
  ) {
    return null;
  }
  const activeDamageText = activeDamage
    ? `場の${activeOwn.name}の最大打点は${activeDamage.move}で約${activeDamage.percentMin}-${activeDamage.percentMax}%です。`
    : `場の${activeOwn.name}はローカル簡易計算で有効な攻撃打点を確認できていません。`;
  return {
    kind: "switch",
    command: best.pokemon.name,
    reason: `${activeDamageText}控えの${best.pokemon.name}は${state.activeOpponent}へ${best.damage.move}で約${best.damage.percentMin}-${best.damage.percentMax}%を見込めるため、最終判断AIが比較するための交代材料です。`,
    risk: "交代ターンに相手の積み技や交代読み打点を受けるリスクがあります。交代すべきかは、相手の自然な行動、HP管理、温存価値を含めて最終判断します。",
    confidence: "low"
  };
}

function withLocalSwitchCandidate(
  store: LocalDataStore,
  state: BattleState,
  candidates: CandidateAction[]
): CandidateAction[] {
  const switchCandidate = localSwitchCandidate(store, state);
  if (!switchCandidate) return candidates;
  if (candidates.some((candidate) => candidate.kind === "switch" && candidate.command === switchCandidate.command)) {
    return candidates;
  }
  const base = candidates.filter((candidate) => candidate.kind !== "selection");
  return [...base.slice(0, 4), switchCandidate];
}

export function sanitizeBattleCandidates(state: BattleState, candidates: CandidateAction[]): CandidateAction[] {
  if (state.phase !== "battle" || state.status !== "active") return candidates;
  const safeCandidates = candidates.filter((candidate) => candidate.kind !== "selection" && isValidBattleCandidate(state, candidate));
  return safeCandidates.length > 0
    ? safeCandidates
    : [{
      kind: "note",
      command: "状況確認",
      reason: "場の自分ポケモンが不明、または候補技が場のポケモンの技ではないため確認が必要です。",
      risk: "こちらの場のポケモンを明示すると次の一手を出せます。",
      confidence: "low"
    }];
}

function pokemonMentionsInOrder(state: BattleState, transcript: string): string[] {
  const baseNames = uniqueNames([
    ...state.ownTeam.map((pokemon) => pokemon.name),
    ...state.opponentTeam.map((pokemon) => pokemon.name)
  ]);
  const names = uniqueNames(baseNames.flatMap((name) => {
    if (!name || name.startsWith("メガ")) return [name];
    return [name, `メガ${name}`, `メガ${name}X`, `メガ${name}Y`];
  }));
  return names
    .map((name) => ({ name, index: transcript.indexOf(name) }))
    .filter((entry) => entry.name && entry.index >= 0)
    .sort((left, right) => left.index - right.index || right.name.length - left.name.length)
    .map((entry) => entry.name);
}

function speedComparisonPokemonState(state: BattleState, name: string): PokemonState | undefined {
  const stripped = name.replace(/^メガ/, "").replace(/[XY]$/i, "");
  return findPokemon(state.ownTeam, name) ??
    findPokemon(state.opponentTeam, name) ??
    findPokemon(state.ownTeam, stripped) ??
    findPokemon(state.opponentTeam, stripped);
}

function pokemonSide(state: BattleState, name: string): "own" | "opponent" {
  const stripped = name.replace(/^メガ/, "").replace(/[XY]$/i, "");
  return state.ownTeam.some((pokemon) => pokemon.name === name || pokemon.name === stripped) ? "own" : "opponent";
}

function isKnownMegaState(pokemon: PokemonState | undefined, local: LocalPokemon): boolean {
  if (local.isMega) return true;
  const item = pokemon?.item.value ?? "";
  return pokemon?.name.startsWith("メガ") || item.includes("メガストーン") || item.includes("ナイト");
}

function speedStageMultiplier(stage: number): number {
  const clamped = Math.max(-6, Math.min(6, stage));
  return clamped >= 0 ? (2 + clamped) / 2 : 2 / (2 - clamped);
}

function parseSpeedStage(statChanges: string): number {
  const normalized = statChanges.normalize("NFKC");
  const explicit = normalized.match(/(?:素早さ|すばやさ|S|スピード)[^+\-0-9]*([+\-][0-6])/i);
  if (explicit) return Number(explicit[1]);
  if (/(?:素早さ|すばやさ|スピード).*(?:ぐーん|2段階|二段階).*(?:上が|上昇)/.test(normalized)) return 2;
  if (/(?:素早さ|すばやさ|スピード).*(?:上が|上昇)/.test(normalized)) return 1;
  if (/(?:素早さ|すばやさ|スピード).*(?:ぐーん|2段階|二段階).*(?:下が|下降)/.test(normalized)) return -2;
  if (/(?:素早さ|すばやさ|スピード).*(?:下が|下降)/.test(normalized)) return -1;
  return 0;
}

function sideHasTailwind(field: string, side: "own" | "opponent"): boolean {
  const normalized = field.normalize("NFKC");
  if (!/追い風|おいかぜ/i.test(normalized)) return false;
  const ownPattern = /(?:こちら|自分|味方|自軍)[^。/]*?(?:追い風|おいかぜ)|(?:追い風|おいかぜ)[^。/]*?(?:こちら|自分|味方|自軍)/i;
  const opponentPattern = /(?:相手|敵)[^。/]*?(?:追い風|おいかぜ)|(?:追い風|おいかぜ)[^。/]*?(?:相手|敵)/i;
  if (side === "own") return ownPattern.test(normalized);
  return opponentPattern.test(normalized);
}

function effectiveSpeed(baseSpeed: number, state: BattleState, pokemon: PokemonState | undefined, side: "own" | "opponent"): number {
  const stage = parseSpeedStage(pokemon?.statChanges ?? "");
  const tailwind = sideHasTailwind(state.field, side);
  return Math.floor(baseSpeed * speedStageMultiplier(stage) * (tailwind ? 2 : 1));
}

function observedSpeedContext(state: BattleState, pokemon: PokemonState | undefined, side: "own" | "opponent"): string {
  const notes: string[] = [];
  const field = state.field.trim();
  const statChanges = pokemon?.statChanges.trim() ?? "";
  if (field && sideHasTailwind(field, side)) {
    notes.push(`現在の場メモに「${field}」があります。`);
  }
  if (statChanges && /素早|すばや|S|スピード|速/i.test(statChanges)) {
    notes.push(`${pokemon?.name ?? "相手"}の能力変化メモは「${statChanges}」です。`);
  }
  if (notes.length > 0) return notes.join("");
  return "現在のメモ上は、追い風や相手の素早さ上昇は確認されていません。";
}

export function speedComparisonCandidate(store: LocalDataStore, state: BattleState, transcript: string): CandidateAction | null {
  const normalized = transcript.replace(/\s+/g, "");
  if (!/(素早|すばや|速|遅).*(より)|より.*(素早|すばや|速|遅)/.test(normalized)) return null;
  const [subject, target] = pokemonMentionsInOrder(state, transcript);
  if (!subject || !target || subject === target) return null;
  const subjectState = speedComparisonPokemonState(state, subject);
  const subjectOwn = pokemonSide(state, subject) === "own" ? subjectState : undefined;
  const targetState = speedComparisonPokemonState(state, target);
  const subjectSide = subjectOwn ? "own" : pokemonSide(state, subject);
  const targetSide = pokemonSide(state, target);
  const subjectLocal = localPokemonForName(store, subject);
  const baseTargetLocal = localPokemonForName(store, target);
  const targetMegaLocals = baseTargetLocal ? megaPokemonForBase(store, baseTargetLocal) : [];
  const targetLocal = baseTargetLocal && targetMegaLocals.length > 0 && isKnownMegaState(targetState, baseTargetLocal)
    ? targetMegaLocals[0]
    : baseTargetLocal;
  if (!subjectLocal || !targetLocal) return null;
  const subjectSpeed = subjectOwn ? knownOwnSpeed(store, subjectOwn) : maxUnboostedSpeed(subjectLocal);
  if (subjectSpeed === null) return null;
  const targetMaxSpeed = maxUnboostedSpeed(targetLocal);
  const subjectEffectiveSpeed = effectiveSpeed(subjectSpeed, state, subjectState, subjectSide);
  const targetEffectiveSpeed = effectiveSpeed(targetMaxSpeed, state, targetState, targetSide);
  const targetMegaOptions = targetMegaLocals.map((pokemon) => {
    const maxSpeed = maxUnboostedSpeed(pokemon);
    return {
      name: displayMegaPokemonName(pokemon, target),
      maxSpeed,
      effectiveSpeed: effectiveSpeed(maxSpeed, state, targetState, targetSide)
    };
  });
  const subjectIsFaster = subjectEffectiveSpeed > targetEffectiveSpeed;
  const subjectIsSlower = subjectEffectiveSpeed < targetEffectiveSpeed;
  const command = subjectIsFaster
    ? `いいえ、${subject}の方が速いです。`
    : subjectIsSlower
      ? `はい、${subject}の方が遅いです。`
      : `${subject}と${target}は最速想定では同速です。`;
  const detail =
    subjectEffectiveSpeed === subjectSpeed && targetEffectiveSpeed === targetMaxSpeed
      ? `${subject}はS${subjectSpeed}、${target}は最速想定でS${targetMaxSpeed}です。`
      : `${subject}はS${subjectSpeed}（実効S${subjectEffectiveSpeed}）、${target}は最速想定でS${targetMaxSpeed}（実効S${targetEffectiveSpeed}）です。`;
  const contextNote = observedSpeedContext(state, targetState, targetSide);
  return {
    kind: "note",
    command,
    reason: `ローカル素早さ比較: ${detail}`,
    risk: contextNote,
    confidence: "high",
    speedComparison: {
      subject,
      target,
      subjectSpeed,
      targetMaxSpeed,
      subjectEffectiveSpeed,
      targetEffectiveSpeed,
      targetMegaOptions,
      contextNote
    }
  };
}

function isSpeedComparisonCandidate(candidate: CandidateAction): candidate is SpeedComparisonAction {
  return candidate.kind === "note" && candidate.reason.startsWith("ローカル素早さ比較:");
}

export function speedComparisonSpeech(candidate: SpeedComparisonAction): string {
  const comparison = candidate.speedComparison;
  if (!comparison) {
    return `${candidate.command}${candidate.reason.replace("ローカル素早さ比較: ", "")} ${candidate.risk}`;
  }
  const { subject, target, subjectSpeed, targetMaxSpeed, subjectEffectiveSpeed, targetEffectiveSpeed } = comparison;
  const effectiveNote =
    subjectSpeed === subjectEffectiveSpeed && targetMaxSpeed === targetEffectiveSpeed
      ? ""
      : `現在の場と能力変化込みでは、${subject}は実効${subjectEffectiveSpeed}、${target}は実効${targetEffectiveSpeed}です。`;
  const fasterMegaOptions = comparison.targetMegaOptions.filter((option) => option.effectiveSpeed > subjectEffectiveSpeed);
  const sameOrSlowerMegaOptions = comparison.targetMegaOptions.filter((option) => option.effectiveSpeed <= subjectEffectiveSpeed);
  const fasterMegaNote = fasterMegaOptions.length > 0
    ? `ただし${target}がメガシンカすると、${fasterMegaOptions
        .map((option) => `${option.name}は最速${option.maxSpeed}${option.effectiveSpeed !== option.maxSpeed ? `、実効${option.effectiveSpeed}` : ""}`)
        .join("、")}なので、メガ後は上を取られます。`
    : "";
  const slowerMegaNote = sameOrSlowerMegaOptions.length > 0
    ? `一方で${sameOrSlowerMegaOptions
        .map((option) => `${option.name}は最速${option.maxSpeed}${option.effectiveSpeed !== option.maxSpeed ? `、実効${option.effectiveSpeed}` : ""}`)
        .join("、")}なので、現在条件では${subject}が上です。`
    : "";
  const megaNote = `${fasterMegaNote}${slowerMegaNote}`;
  if (subjectEffectiveSpeed > targetEffectiveSpeed) {
    return `いいえ、マスターの${subject}の素早さは${subjectSpeed}ですが、${target}は最速でも${targetMaxSpeed}なので、${subject}のほうが速いです。${effectiveNote}${megaNote}${comparison.contextNote}`;
  }
  if (subjectEffectiveSpeed < targetEffectiveSpeed) {
    return `はい、マスターの${subject}の素早さは${subjectSpeed}ですが、${target}は最速で${targetMaxSpeed}まで上がるので、${subject}のほうが遅いです。${effectiveNote}${comparison.contextNote}`;
  }
  return `マスターの${subject}の素早さは${subjectSpeed}で、${target}も最速なら${targetMaxSpeed}なので同速です。${effectiveNote}${megaNote}${comparison.contextNote}`;
}

function ensureOpponentPokemon(state: BattleState, name: string): BattleState {
  if (!name.trim()) return state;
  if (state.opponentTeam.some((pokemon) => pokemon.name === name)) return state;
  const similar = state.opponentTeam.find((pokemon) => pokemon.name && samePokemonName(pokemon.name, name));
  if (similar) {
    return {
      ...state,
      activeOpponent: samePokemonName(state.activeOpponent, similar.name) ? name : state.activeOpponent,
      opponentTeam: state.opponentTeam.map((pokemon) => (
        pokemon.id === similar.id ? { ...pokemon, name } : pokemon
      ))
    };
  }
  const emptyIndex = state.opponentTeam.findIndex((pokemon) => !pokemon.name);
  if (emptyIndex < 0) return state;
  const next = [...state.opponentTeam];
  next[emptyIndex] = { ...createPokemon(`opp-${emptyIndex + 1}`, name), notes: "音声入力から確認" };
  return { ...state, opponentTeam: next };
}

function updateTeamPokemon(team: PokemonState[], name: string, update: (pokemon: PokemonState) => PokemonState) {
  return team.map((pokemon) => (
    pokemon.name === name || pokemon.id === name || samePokemonName(pokemon.name, name) ? update(pokemon) : pokemon
  ));
}

function mergeKnownValue(current: KnownValue, next: KnownValue): KnownValue {
  if (current.status === "confirmed" && next.status !== "confirmed") return current;
  if (!next.value) return current;
  return next;
}

function megaCandidateNamesFromFacts(facts: BattleFacts): Array<string | undefined> {
  return [
    ...facts.opponentMentionedPokemon,
    ...facts.opponentSelectedPokemon,
    facts.activeOpponent,
    ...facts.hpUpdates.filter((update) => update.side === "opponent").map((update) => update.pokemon),
    ...facts.faintedPokemon.filter((fainted) => fainted.side === "opponent").map((fainted) => fainted.pokemon),
    ...facts.statuses.filter((status) => status.side === "opponent").map((status) => status.pokemon),
    ...facts.revealedItem.map((item) => item.pokemon),
    ...facts.damageCalcRequests.map((request) => request.attacker),
    ...facts.damageCalcRequests.map((request) => request.defender)
  ];
}

function ownMegaCandidateNamesFromFacts(facts: BattleFacts): Array<string | undefined> {
  return [
    ...facts.ownMentionedPokemon,
    ...facts.ownSelectedPokemon,
    facts.activeOwn,
    ...facts.hpUpdates.filter((update) => update.side === "own").map((update) => update.pokemon),
    ...facts.faintedPokemon.filter((fainted) => fainted.side === "own").map((fainted) => fainted.pokemon),
    ...facts.statuses.filter((status) => status.side === "own").map((status) => status.pokemon)
  ];
}

export function applyFactsToState(state: BattleState, rawFacts: BattleFacts, store: LocalDataStore): BattleState {
  const megaEvolutions = collectMegaEvolutions(store, megaCandidateNamesFromFacts(rawFacts));
  const ownMegaEvolutions = collectMegaEvolutions(store, ownMegaCandidateNamesFromFacts(rawFacts));
  const facts = rewriteOwnMegaFactReferences(rewriteOpponentMegaFactReferences(rawFacts, megaEvolutions), ownMegaEvolutions);
  let next = applyOwnMegaEvolutions(applyOpponentMegaEvolutions({ ...state }, megaEvolutions), ownMegaEvolutions);
  // 同一対戦内でbattleからselectionへは戻さない。ひんし後の「次のポケモンを選んで」は交代であって再選出ではない。
  if (facts.phase && !(state.phase === "battle" && state.status === "active" && facts.phase === "selection")) {
    next.phase = facts.phase;
  }
  if (facts.opponentName?.trim()) {
    next.opponentName = facts.opponentName.trim();
  }
  if (facts.field?.trim()) {
    next.field = facts.field.trim();
  }

  for (const name of facts.opponentMentionedPokemon) {
    if (!isOwnPokemon(next, name)) {
      next = ensureOpponentPokemon(next, name);
    }
  }

  if (facts.ownSelectedPokemon.length > 0) {
    const selected = new Set(facts.ownSelectedPokemon.filter((name) => findPokemon(next.ownTeam, name)));
    const currentSelectedCount = next.ownTeam.filter((pokemon) => pokemon.selected).length;
    const shouldReplaceSelection = next.phase === "selection" || currentSelectedCount === 0;
    const shouldMergeSelection = next.phase !== "selection" && currentSelectedCount > 0 && selected.size < 3;
    next.ownTeam = next.ownTeam.map((pokemon) => ({
      ...pokemon,
      selected: shouldReplaceSelection
        ? selected.has(pokemon.name)
        : pokemon.selected || (shouldMergeSelection && selected.has(pokemon.name))
    }));
  }

  if (facts.opponentSelectedPokemon.length > 0) {
    for (const name of facts.opponentSelectedPokemon) {
      next = ensureOpponentPokemon(next, name);
    }
    if (facts.opponentSelectedPokemon.length <= 3) {
      const selected = new Set(facts.opponentSelectedPokemon);
      next.opponentTeam = next.opponentTeam.map((pokemon) => ({
        ...pokemon,
        selected: selected.size === 3 ? selected.has(pokemon.name) : pokemon.selected || selected.has(pokemon.name)
      }));
    }
  }

  if (facts.activeOwn && findPokemon(next.ownTeam, facts.activeOwn)) {
    next = activateOwnPokemon(next, facts.activeOwn);
  } else if (next.phase === "battle" && !next.activeOwn) {
    const inferredActiveOwn = inferActiveOwnName(next, facts);
    if (inferredActiveOwn) next = activateOwnPokemon(next, inferredActiveOwn);
  }
  if (facts.activeOpponent) {
    next = ensureOpponentPokemon(next, facts.activeOpponent);
    const activeOpponent = findPokemon(next.opponentTeam, facts.activeOpponent)?.name ?? facts.activeOpponent;
    next.activeOpponent = activeOpponent;
    next.opponentTeam = next.opponentTeam.map((pokemon) => ({
      ...pokemon,
      active: samePokemonName(pokemon.name, activeOpponent),
      selected: pokemon.selected || samePokemonName(pokemon.name, activeOpponent)
    }));
  }

  for (const hpUpdate of facts.hpUpdates) {
    const target = hpUpdate.side === "own" ? "ownTeam" : "opponentTeam";
    const hpPercent = Math.max(0, Math.min(100, hpUpdate.hpPercent));
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], hpUpdate.pokemon, (pokemon) => ({
        ...pokemon,
        hpPercent,
        currentHp: target === "ownTeam" && pokemon.maxHp ? Math.round((pokemon.maxHp * hpPercent) / 100) : pokemon.currentHp
      }))
    };
  }

  const faintedPokemon = [...facts.faintedPokemon];
  for (const fainted of faintedPokemon) {
    const target = fainted.side === "own" ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], fainted.pokemon, (pokemon) => ({
        ...pokemon,
        hpPercent: 0,
        currentHp: target === "ownTeam" ? 0 : pokemon.currentHp,
        condition: "ひんし",
        active: false,
        selected: pokemon.selected || target === "opponentTeam"
      }))
    };
    if (fainted.side === "own" && next.activeOwn === fainted.pokemon) next.activeOwn = "";
    if (fainted.side === "opponent" && next.activeOpponent === fainted.pokemon) next.activeOpponent = "";
  }
  if (!next.activeOpponent && facts.opponentSelectedPokemon.length === 1) {
    const faintedOpponentNames = new Set(faintedPokemon.filter((pokemon) => pokemon.side === "opponent").map((pokemon) => pokemon.pokemon));
    const replacement = facts.opponentSelectedPokemon.find((pokemon) => !faintedOpponentNames.has(pokemon));
    if (replacement) {
      next = ensureOpponentPokemon(next, replacement);
      const activeOpponent = findPokemon(next.opponentTeam, replacement)?.name ?? replacement;
      next.activeOpponent = activeOpponent;
      next.opponentTeam = next.opponentTeam.map((pokemon) => ({
        ...pokemon,
        active: samePokemonName(pokemon.name, activeOpponent),
        selected: pokemon.selected || samePokemonName(pokemon.name, activeOpponent)
      }));
    }
  }

  for (const status of facts.statuses) {
    const target = status.side === "own" ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], status.pokemon, (pokemon) => ({
        ...pokemon,
        condition: mergeConditionText(pokemon.condition, status.condition)
      }))
    };
  }

  for (const move of facts.revealedMoves) {
    const target = isOwnPokemon(next, move.pokemon) ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], move.pokemon, (pokemon) => {
        const existing = pokemon.moves.find((entry) => entry.value === move.move);
        if (existing) {
          return {
            ...pokemon,
            moves: pokemon.moves.map((entry) =>
              entry.value === move.move ? mergeKnownValue(entry, { value: move.move, status: statusFromCertainty(move.certainty) }) : entry
            )
          };
        }
        return {
          ...pokemon,
          moves: [...pokemon.moves, { value: move.move, status: statusFromCertainty(move.certainty) }]
        };
      })
    };
  }

  for (const ability of facts.revealedAbility) {
    const target = isOwnPokemon(next, ability.pokemon) ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], ability.pokemon, (pokemon) => ({
        ...pokemon,
        ability: mergeKnownValue(pokemon.ability, {
          value: ability.ability,
          status: statusFromCertainty(ability.certainty)
        })
      }))
    };
  }

  for (const item of facts.revealedItem) {
    const target = isOwnPokemon(next, item.pokemon) ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], item.pokemon, (pokemon) => ({
        ...pokemon,
        item: mergeKnownValue(pokemon.item, {
          value: item.item,
          status: statusFromCertainty(item.certainty)
        })
      }))
    };
  }

  for (const statChange of facts.statChanges) {
    const target = statChange.side === "own" ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], statChange.pokemon, (pokemon) => ({
        ...pokemon,
        statChanges:
          pokemon.statChanges && !pokemon.statChanges.includes(statChange.changes)
            ? `${pokemon.statChanges} / ${statChange.changes}`
            : statChange.changes
      }))
    };
  }

  if (facts.notes.length > 0) {
    next.latestMemo = facts.notes.join(" / ");
  }

  return normalizeBattleState(applyOwnMegaEvolutions(applyOpponentMegaEvolutions(next, megaEvolutions), ownMegaEvolutions));
}

function buildFactsPrompt(state: BattleState, transcript: string): string {
  const ownNames = state.ownTeam.map((pokemon) => pokemon.name).join(" / ");
  return `
あなたはPokemon Champions対戦ログの事実抽出器です。判断や助言はせず、入力文から事実だけをJSONで返してください。

こちらの6体: ${ownNames}
対戦相手名: ${state.opponentName || "未設定"}
対戦ステータス: ${state.status}

ルール:
- ownTeamに存在しないポケモン名は自分側として扱わない。
- ownTeamのメタグロスは、初期状態では「メタグロス」として扱う。「メガ進化した」「こちらのメガメタグロス」など自分側のメガ進化が明示された場合だけ、以後「メガメタグロス」として扱う。
- 「対戦相手は〇〇さん」「相手の名前は〇〇」「〇〇さんと対戦」などは opponentName に入れる。
- opponentName はプレイヤー名だけ。ポケモン名や敬称だけを誤って入れない。
- 「こちら」「裏選出」など曖昧でも、ownTeam外の名前は相手側情報として扱う。
- 相手のパーティ6体、見せ合い6体、「相手のポケモンは...」は opponentMentionedPokemon に入れる。こちらの6体と同名のポケモン（例: ガブリアス、マスカーニャ）が含まれていても、相手の文脈なら opponentMentionedPokemon に入れる。opponentSelectedPokemon には入れない。
- opponentSelectedPokemon は「相手の選出はA/B/C」「初手A」「Aを出してきた」「裏からB」「2体目B」など、実際の選出・場に出たことが明示された場合だけ入れる。
- ownMentionedPokemon は「私のA」「こちらのA」「AはBより速い/遅いか」など、こちらの6体に含まれるポケモンが話題に出た場合に入れる。選出確定とは別扱いにする。
- 戦闘中に「こちらはA」「Aで攻撃」「AのHPが...」のように場の1体だけが出た場合は activeOwn に入れ、ownSelectedPokemon を1体だけにしない。
- 6体すべてを opponentSelectedPokemon に入れてはいけない。明示された選出3体でない限り、最大でも今回新しく場に出たポケモンだけにする。
- 「初手A」「Aを投げてきた」「Aを出してきた」「裏からA」は activeOpponent にもAを入れる。
- 相手が「メガA」に進化した、または「メガA」と判明した場合は、以後その相手ポケモン名をメガAとして扱い、revealedItem に item="メガストーン" confirmed を入れる。
- 「Aを倒した」「Aを倒せた」「Aを落とした」「Aがひんし」は faintedPokemon に入れ、side は相手を倒したなら opponent、自分が倒されたなら own。
- 対戦が始まった後(現在stateのphaseがbattle)は、「次のポケモンを選んで」「次を出して」と言われても phase は battle のまま。これは控えへの交代であって再選出ではない。
- 相手が「きあいのタスキ」「気合のタスキ」「きあいのハチマキ」などで持ちこたえた/耐えた場合は、相手側 hpUpdates に hpPercent=1 を入れ、revealedItem にその持ち物を confirmed で入れる。
- 天気、フィールド、トリックルームなど全体に影響する情報は field に「全体: 雨」のように入れる。
- ステルスロック、まきびし、どくびし、ねばねばネット、追い風、壁、しんぴのまもりなど片側の場に残る情報は、必ず「自分側: ステルスロック」「相手側: ひかりのかべ」のように、どちら側にあるかを明記して field に入れる。側が本当に不明なら「側不明: ステルスロック」と書く。
- 「Aの素早さが上がった」「S+1」「Aの攻撃が下がった」など能力ランク変化は statChanges に入れる。pokemon は対象、changes は「素早さ+1」「攻撃-1」など短く書く。
- まひ、やけど、ねむり、こおり、どく、こんらん、みがわり、ちょうはつ、アンコール、かなしばり、ほろびのうた、やどりぎ、のろいなどポケモン個別に残る状態は statuses に入れる。
- 確定していない技・特性・持ち物は suspected、発話で明確なら confirmed。
- 雑談や対戦に無関係な話は、notes に短く残し、対戦stateを無理に更新しない。
- 分からない項目は空配列または省略。
- JSON以外は返さない。

会話記憶:
${state.history.length > 0 ? state.history.slice(-5).map((entry) => `- ${entry.transcript} => ${entry.action}`).join("\n") : "なし"}

現在state:
${JSON.stringify(compactStateForPrompt(state))}

入力:
${transcript}

返す形式:
{
  "phase": "selection" | "battle",
  "opponentName": "",
  "opponentMentionedPokemon": [],
  "opponentSelectedPokemon": [],
  "ownMentionedPokemon": [],
  "ownSelectedPokemon": [],
  "field": "",
  "statChanges": [],
  "activeOwn": "",
  "activeOpponent": "",
  "hpUpdates": [],
  "faintedPokemon": [],
  "statuses": [],
  "revealedMoves": [],
  "revealedAbility": [],
  "revealedItem": [],
  "damageCalcRequests": [],
  "notes": []
}
`;
}

function buildCandidatesPrompt(payload: z.infer<typeof updatedPayloadSchema>): string {
  const ownNames = payload.updatedState.ownTeam.map((pokemon) => pokemon.name).join(" / ");
  return `
Pokemon Championsの次アクション候補を作ってください。最終決定ではなく、候補だけを返します。

会話intent: ${payload.conversationIntent}
対戦相手名: ${payload.updatedState.opponentName || "未設定"}
対戦ステータス: ${payload.updatedState.status}

ルール:
- 会話intent が chat または memory、または対戦ステータスが review の場合は、必ず kind は note にして、対戦指示や選出指示を出さない。
- 対戦ステータスが review の場合は、履歴・メモ・選出を見て反省会の観点を返す。
- 選出画面では ownTeam の6体から3体を選ぶ候補を2-3案作る。
- 選出候補の command は、必ずこちらの6体から選んだ3体名だけを「ポケモン名、ポケモン名、ポケモン名」の形式にする。
- こちらの6体は ${ownNames} のみ。これ以外を command に入れない。
- 対戦中は次の一手候補だけを作る。
- 対戦中の switch 候補は、現在 selected=true の自分ポケモンだけにする。未選出の自分ポケモンを交代候補にしてはいけない。
- ダメージ計算結果がある場合は必ず候補理由に反映する。
- 候補に moveMatchup が付いている場合は、その effectiveness / percentMax / userMovesFirstBySpeed を優先し、半減以下で低火力の技を高評価しない。
- 雑談や記憶してほしい話題なら、kind は note にして自然な返答候補を作る。
- ポケモン別ナレッジは見出しに書かれたポケモン専用。現在対面やリスク説明で別ポケモンのナレッジを流用しない。
- 素早さ・先手後手の確認では、必ず「素早さ比較用データ」の ownKnownSpeed / maxUnboostedSpeed / baseSpe を優先する。記憶や一般知識だけで速い・遅いを断定しない。

こちらの構築メモ:
${payload.teamDoc}

会話記憶:
${limitText(payload.memoryContext || "なし", 3000)}

抽出済み事実:
${JSON.stringify(payload.facts)}

解決済み名前:
${JSON.stringify(payload.resolvedNames)}

ローカルポケモンデータ:
${payload.localKnowledge}

ダメージ計算:
${JSON.stringify(payload.damageCalcs)}

現在state:
${JSON.stringify(compactStateForPrompt(payload.updatedState))}

マスターの最新説明:
${payload.transcript}
`;
}

function battleTurnTeamDoc(doc: string): string {
  return doc.replace(/## 最終パーティ[\s\S]*?(?=\n\n## |$)/, "").trim();
}

function damagePercentPhrase(maxPercent: number): string {
  if (maxPercent >= 100) return "倒し切れる火力";
  if (maxPercent >= 70) return "大きく削れる火力";
  if (maxPercent >= 40) return "しっかり削れる火力";
  if (maxPercent >= 15) return "削りは控えめ";
  return "かなり削れている状態";
}

export function sanitizeSpeechForVoice(speech: string): string {
  return speech
    .replace(/HP\s*(?:は)?\s*\d+(?:\.\d+)?\s*%/g, "HPはかなり削れた状態")
    .replace(
      /(?:概算|約)?\d+(?:\.\d+)?\s*[-〜~－]\s*\d+(?:\.\d+)?\s*%/g,
      (match) => {
        const values = [...match.matchAll(/\d+(?:\.\d+)?/g)].map((entry) => Number(entry[0]));
        return damagePercentPhrase(Math.max(...values));
      }
    )
    .replace(
      /(?:概算|約)?\d+(?:\.\d+)?\s*%/g,
      (match) => {
        const value = Number(match.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
        return damagePercentPhrase(value);
      }
    )
    .replace(/火力まで/g, "ところまで")
    .replace(/状態まで/g, "ところまで")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDecisionPrompt(payload: z.infer<typeof candidatesPayloadSchema>): string {
  const ownNames = payload.updatedState.ownTeam.map((pokemon) => pokemon.name).join(" / ");
  const isActiveBattleTurn =
    payload.conversationIntent === "battle" &&
    payload.updatedState.phase === "battle" &&
    payload.updatedState.status === "active";
  const rules = [
    ...(isActiveBattleTurn
      ? [
          "会話intent が battle、対戦ステータスが active、現在phaseがbattleのため、短い盤面報告、確認、実行宣言に見える発話でも候補から技または交代の一手を返す。",
          "原則として action.kind は move または switch にする。note は候補が作れない場合だけにする。"
        ]
      : [
          `会話intent が chat または memory の場合は、必ず action.kind = "note" にして、選出・技・交代の新規指示を出さない。`,
          "対戦ステータスが review の場合は、勝敗・選出・分岐・次回改善点の反省会として返す。",
          "会話intent が battle、対戦ステータスが active、現在phaseがbattleの場合は、対戦相談ボタン経由として扱い、短い盤面報告、確認、実行宣言に見える発話でも候補から技または交代の一手を返す。",
          `battle intent の active battle では、原則として action.kind は move または switch にする。note は候補が作れない場合だけにする。`,
          `chat / memory intent でマスターが確認、報告、待機、実行宣言をしているだけなら、action.kind = "note" で短く受ける。battle intent では次の一手を決める。`,
          "選出画面では ownTeam の6体から3体を選び、選んだ3体だけ selected: true にする。",
          `選出画面の action.command は、必ずこちらの6体から選んだ3体名だけを「ポケモン名、ポケモン名、ポケモン名」の形式で返す。`,
          "選出画面の speech では、必ず「先発は〇〇」と先発ポケモンを明示する。先発は action.command の1体目として扱う。",
          `選出画面の speech は、必ず最後を「${payload.updatedState.opponentName ? `${payload.updatedState.opponentName.replace(/さん$/, "")}さん` : "対戦相手さん"}、対戦よろしくお願いします。」で締める。`
        ]),
    "候補は判断材料であり、候補順やローカル補助だけで最終手を固定しない。相手の自然な行動、こちらのHP、温存価値、リスクを総合してAIニケちゃんとして最終判断する。",
    `こちらの6体は ${ownNames} のみ。これ以外のポケモン名を action.command に入れてはいけない。`,
    "ownTeam は絶対に3体へ削らず、6体すべてを保持する。",
    "対戦中に交代する場合は、現在 selected=true かつひんしでない自分ポケモンだけを選ぶ。未選出の自分ポケモンへ交代してはいけない。",
    "ダメ計結果がある場合は必ず判断材料にする。",
    "候補に moveMatchup が付いている場合は、AIの一般論より moveMatchup を優先する。より高い percentMax の技があるのに、半減以下・低火力の先制技や一致技を選んではいけない。",
    `userMovesFirstBySpeed が true の場面では、先制技は「先に動くため」だけでは優先しない。通常技の火力・相性を比較して選ぶ。`,
    `対戦に関係する確認質問でも、操作判断を求められていないなら action.kind = "note" で答える。`,
    "マスターの好みや過去会話に関係する場合は、会話記憶を判断材料にする。",
    "speech はAIニケちゃんとしてマスターにそのまま話すセリフ。音声再生される前提で、自然な日本語1〜3文にする。",
    `speech には command だけでなく、「なぜそうするか」を短く含める。例: 「ペリッパーとラグラージの雨展開が見えるので、ここはガブリアス、アシレーヌ、メタグロスでいきましょう！」`,
    "speech には細かいダメージ%や計算値を入れない。「大きく削れる」「倒し切れる火力」「圏内」のような自然な言い方にする。",
    "Pokemon Championsローカルデータを優先する。ローカルポケモンデータに書かれていないタイプ・特性・無効耐性を昔の知識で補完してはいけない。",
    "ポケモン別ナレッジは見出しに書かれたポケモン専用。現在対面やリスク説明で別ポケモンのナレッジを流用しない。",
    "候補理由にローカルデータの型・特性・相性が書かれている場合、それと矛盾する説明をしてはいけない。",
    `素早さ・先手後手の確認では、必ず「素早さ比較用データ」の ownKnownSpeed / maxUnboostedSpeed / baseSpe を優先する。記憶や一般知識だけで速い・遅いを断定しない。`,
    "返答はJSONだけ。Markdownや説明文を外に出さない。"
  ];
  const teamDoc = isActiveBattleTurn ? battleTurnTeamDoc(payload.teamDoc) : payload.teamDoc;
  return `
あなたはAIニケちゃん。Pokemon Championsのシングル対戦で、マスターが実際に操作し、あなたは状況に応じて選出・次の一手・確認応答を返す。

会話intent: ${payload.conversationIntent}
対戦相手名: ${payload.updatedState.opponentName || "未設定"}
対戦ステータス: ${payload.updatedState.status}

絶対ルール:
${rules.map((rule) => `- ${rule}`).join("\n")}

こちらの構築メモ:
${teamDoc}

会話記憶:
${limitText(payload.memoryContext || "なし", 3000)}

抽出済み事実:
${JSON.stringify(payload.facts)}

解決済み名前:
${JSON.stringify(payload.resolvedNames)}

ローカルポケモンデータ:
${payload.localKnowledge}

ダメージ計算:
${JSON.stringify(payload.damageCalcs)}

候補:
${JSON.stringify(payload.candidates)}

現在state:
${JSON.stringify(compactStateForPrompt(payload.updatedState))}

マスターの最新説明:
${payload.transcript}

返すJSON形式:
{
  "action": {
    "kind": "selection" | "move" | "switch" | "note",
    "command": "マスターが今押すべき一手。選出なら3体名。対戦中なら技名または交代先だけを明確に",
    "reason": "短い理由",
    "risk": "主なリスク。不明なら不明点",
    "confidence": "high" | "medium" | "low"
  },
  "speech": "AIニケちゃんとしてマスターに話す自然なセリフ",
  "memo": "このターンで更新したメモ",
  "selectedOwnPokemon": ["選出画面のときだけ、自分の6体から選んだ3体名"]
}
`;
}

function buildMemoryExtractionPrompt(payload: z.infer<typeof advicePayloadSchema>): string {
  return `
マスターとの会話から、今後も参照すると役立つ長期記憶だけを抽出してください。

保存するもの:
- マスターの好み、方針、判断基準
- 対戦で繰り返し使えそうな学び
- この構築の反省や相性知識
- 相手や環境について後で参照したい情報
- 雑談でも、マスターの継続的な好みや重要な近況なら保存する

保存しないもの:
- そのターンだけのHPや一時的な盤面
- すでに同じ意味で記憶済みの内容
- 挨拶だけ、短い相づちだけ
- 不確かな固有情報の断定
- ローカルデータや計算で検証していない素早さ・ダメージ・相性の断定

scope:
- global: 一般的な会話・継続的な情報
- preference: マスターの好みや判断傾向
- team: この構築・選出・立ち回りの知見
- battle: この対戦内で後から参照したい要点
- opponent: 相手や型の傾向

既存記憶:
${payload.memoryContext || "なし"}

対戦相手名:
${payload.updatedState.opponentName || "未設定"}

対戦ステータス:
${payload.updatedState.status}

マスターの発話:
${payload.transcript}

ニケちゃんの返答:
${payload.advice.speech}

このターンのメモ:
${payload.advice.memo}

返すJSON:
{
  "notes": [
    {
      "scope": "global" | "preference" | "team" | "battle" | "opponent",
      "content": "150文字以内の独立した記憶",
      "confidence": "confirmed" | "inferred",
      "tags": []
    }
  ]
}
`;
}

function validateSelectionAdvice(result: AdviceResult): string[] {
  if (result.updatedState.phase !== "selection" && result.action.kind !== "selection") return [];

  const errors: string[] = [];
  const ownNames = result.updatedState.ownTeam.map((pokemon) => pokemon.name);
  const selectedOwnNames = result.updatedState.ownTeam.filter((pokemon) => pokemon.selected).map((pokemon) => pokemon.name);
  const commandOwnNames = extractCommandOwnNames(result.action.command, ownNames);
  if (result.updatedState.ownTeam.length !== 6) {
    errors.push("ownTeam must keep exactly six Pokemon.");
  }
  if (selectedOwnNames.length !== 3) {
    errors.push(`selection must mark exactly three ownTeam Pokemon, got ${selectedOwnNames.length}.`);
  }
  if (commandOwnNames.length !== 3) {
    errors.push(`selection command must contain exactly three ownTeam Pokemon, got ${commandOwnNames.length}.`);
  }
  const speechMissing = commandOwnNames.filter((name) => !result.speech.includes(name));
  if (speechMissing.length > 0) {
    errors.push(`speech must mention selected own Pokemon names: ${speechMissing.join(", ")}.`);
  }
  const leadName = commandOwnNames[0];
  if (leadName && !result.speech.includes(selectionLeadSentence(leadName))) {
    errors.push(`selection speech must identify lead Pokemon: ${leadName}.`);
  }
  const activeOwnNames = result.updatedState.ownTeam.filter((pokemon) => pokemon.active).map((pokemon) => pokemon.name);
  if (leadName && result.updatedState.activeOwn !== leadName) {
    errors.push(`selection must set activeOwn to lead Pokemon: ${leadName}.`);
  }
  if (leadName && !sameNames(activeOwnNames, [leadName])) {
    errors.push(`selection must mark only lead Pokemon active: ${leadName}.`);
  }
  const greeting = selectionGreeting(result.updatedState);
  if (!result.speech.trim().endsWith(greeting)) {
    errors.push(`selection speech must end with greeting: ${greeting}`);
  }
  const missing = selectedOwnNames.filter((name) => !result.action.command.includes(name));
  if (missing.length > 0) {
    errors.push(`action.command must include selected own Pokemon names: ${missing.join(", ")}.`);
  }
  const forbidden = result.action.command
    .split(/[、,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !ownNames.includes(part));
  if (forbidden.length > 0) {
    errors.push(`action.command contains Pokemon outside ownTeam: ${forbidden.join(", ")}.`);
  }
  return errors;
}

function extractCommandOwnNames(command: string, ownNames: string[]): string[] {
  return ownNames.filter((name) => command.includes(name));
}

function sameNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((name) => rightSet.has(name));
}

function selectionGreeting(state: BattleState): string {
  const rawName = state.opponentName.trim().replace(/さん$/, "") || "対戦相手";
  return `${rawName}さん、対戦よろしくお願いします。`;
}

function selectionLeadSentence(leadName: string): string {
  return `先発は${leadName}です。`;
}

function selectionSpeech(command: string, selectedNames: string[], state: BattleState): string {
  const leadName = selectedNames[0] ?? command.split(/[、,]/)[0] ?? "";
  return `ここは${command}でいきましょう。${selectionLeadSentence(leadName)} ${selectionGreeting(state)}`;
}

function selectionCandidateNames(candidates: Array<z.infer<typeof candidateActionSchema>>, ownNames: string[]): string[] {
  const selectionCandidate = candidates.find((candidate) => candidate.kind === "selection");
  return selectionCandidate ? extractCommandOwnNames(selectionCandidate.command, ownNames) : [];
}

function repairSelectionAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: Array<z.infer<typeof candidateActionSchema>> = []
): AdviceResult {
  const selected = advice.updatedState.ownTeam.filter((pokemon) => pokemon.selected).map((pokemon) => pokemon.name);
  const ownNames = fallbackState.ownTeam.map((pokemon) => pokemon.name);
  const commandSelected = extractCommandOwnNames(advice.action.command, ownNames);
  const candidateSelected = selectionCandidateNames(candidates, ownNames);
  const safeSelected = commandSelected.length === 3
    ? commandSelected
    : candidateSelected.length === 3
      ? candidateSelected
      : selected.length === 3
      ? selected
      : fallbackState.ownTeam.slice(0, 3).map((pokemon) => pokemon.name);
  const command = safeSelected.join("、");
  const leadSentence = selectionLeadSentence(safeSelected[0]);
  const greeting = selectionGreeting(advice.updatedState);
  const needsAlignment =
    advice.action.kind !== "selection" ||
    advice.action.command !== command ||
    !sameNames(selected, safeSelected) ||
    safeSelected.some((name) => !advice.speech.includes(name)) ||
    !advice.speech.includes(leadSentence) ||
    !advice.speech.trim().endsWith(greeting);
  const updatedState = normalizeBattleState({
    ...advice.updatedState,
    activeOwn: safeSelected[0],
    ownTeam: fallbackState.ownTeam.map((pokemon) => ({
      ...pokemon,
      selected: safeSelected.includes(pokemon.name),
      active: pokemon.name === safeSelected[0]
    }))
  });
  return {
    ...advice,
    updatedState,
    speech: needsAlignment
      ? selectionSpeech(command, safeSelected, updatedState)
      : advice.speech,
    action: {
      ...advice.action,
      kind: "selection",
      command,
      reason: needsAlignment
        ? "選出ガードで、画面表示・内部state・セリフが同じ3体になるように揃えました。"
        : advice.action.reason,
      risk: advice.action.risk || "相手の型や選出順が不明な場合は、初手対面で再判断します。"
    }
  };
}

function repairNoteModeAdvice(advice: AdviceResult, fallbackState: BattleState, reason: string): AdviceResult {
  return {
    ...advice,
    updatedState: fallbackState,
    speech: advice.speech || advice.action.reason || advice.memo || "了解です。",
    action: {
      kind: "note",
      command: advice.action.kind === "note" ? advice.action.command : "覚えておきました",
      reason: advice.action.reason || advice.memo || reason,
      risk: advice.action.risk || "対戦状態は更新していません。",
      confidence: advice.action.confidence
    }
  };
}

export function isPositiveFeedback(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, "");
  if (!normalized) return false;
  if (/(何を|どうすれば|どうしたら|ですか|ますか|でしょうか|かな|かね|教えて|相談|\?|？)/.test(normalized)) {
    return false;
  }
  return /(いいと思います|良いと思います|よいと思います|いいですね|良いですね|よさそう|良さそう|いい感じ|良い感じ|助かります|ありがとう|ありがたい|ナイス|さすが)/.test(normalized);
}

function latestSelectionSummary(state: BattleState): string {
  const selected = state.ownTeam.filter((pokemon) => pokemon.selected).map((pokemon) => pokemon.name);
  if (selected.length === 3) return selected.join("、");
  const latestSelection = [...state.history].reverse().find((entry) => entry.action.includes("、"));
  return latestSelection?.action ?? "";
}

function repairPositiveFeedbackAdvice(advice: AdviceResult, fallbackState: BattleState, transcript: string): AdviceResult {
  if (!isPositiveFeedback(transcript)) return advice;
  const selection = latestSelectionSummary(fallbackState);
  const speech =
    fallbackState.phase === "selection" && selection
      ? `そう言ってもらえてよかったです、マスター。では${selection}でいきましょう。`
      : "そう言ってもらえてよかったです、マスター。この方針で進めましょう。";
  return {
    ...advice,
    updatedState: fallbackState,
    speech,
    memo: advice.memo || "マスターが方針に肯定的な反応。",
    action: {
      kind: "note",
      command: "方針確認",
      reason: "マスターが提案内容に肯定的な反応を返したため、機械的な了承ではなく自然に受けました。",
      risk: "新しい対戦指示は出していません。",
      confidence: advice.action.confidence
    }
  };
}

export function isExecutionAcknowledgement(transcript: string): boolean {
  const normalized = transcript.replace(/\s+/g, "");
  if (!normalized) return false;
  if (/(何を|どうすれば|どうしたら|すべき|した方が|いいですか|ですか|ますか|でしょうか|ですかね|かね|かな|教えて|相談|選んで|決めて|\?|？)/.test(normalized)) {
    return false;
  }
  return /(わかりました|分かりました|了解|承知|OK|オーケー|では|じゃあ|それで|その手で|その一手で|でいきます|で行きます|をします|押します|打ちます|撃ちます|選びます|使います|してきます|待ってて|待ってください)/.test(normalized);
}

function repairExecutionAcknowledgementAdvice(advice: AdviceResult, fallbackState: BattleState, transcript: string): AdviceResult {
  if (fallbackState.phase !== "battle" || fallbackState.status !== "active" || !isExecutionAcknowledgement(transcript)) {
    return advice;
  }
  return {
    ...advice,
    updatedState: fallbackState,
    speech: "はい、お願いします。結果が分かったら教えてください。",
    memo: advice.memo || "マスターが前回の指示を実行すると報告。",
    action: {
      kind: "note",
      command: "状況確認",
      reason: advice.action.reason || "マスターが前回の指示を実行すると報告したため、新しい操作指示は出しません。",
      risk: "新規の対戦指示は出していません。",
      confidence: advice.action.confidence
    }
  };
}

function repairBattleNoteAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  if (fallbackState.phase !== "battle" || fallbackState.status !== "active" || advice.action.kind !== "note") return advice;
  const fallbackAction = candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch");
  if (!fallbackAction) return advice;
  return {
    ...advice,
    updatedState: fallbackState,
    action: fallbackAction,
    speech: `ここは${fallbackAction.command}でいきましょう。${fallbackAction.reason}`,
    memo: fallbackAction.reason
  };
}

function repairInvalidActiveMoveAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  if (fallbackState.phase !== "battle" || fallbackState.status !== "active" || advice.action.kind !== "move") return advice;
  if (isValidActiveMoveCandidate(fallbackState, advice.action)) return advice;
  const fallbackAction = candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch") ?? {
    kind: "note" as const,
    command: "場のポケモン確認",
    reason: "場にいる自分ポケモンが覚えていない技が返ったため、操作指示を止めました。",
    risk: "こちらの場のポケモンを明示すると安全に再判断できます。",
    confidence: "low" as const
  };
  return {
    ...advice,
    updatedState: fallbackState,
    action: fallbackAction,
    speech:
      fallbackAction.kind === "note"
        ? "いまの場のポケモンが覚えていない技が出たので、操作指示はいったん止めます。"
        : `さっきの技指示は場のポケモンと合わないので、ここは${fallbackAction.command}に修正します。${fallbackAction.reason}`,
    memo: fallbackAction.reason
  };
}

function repairInvalidActiveSwitchAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  if (fallbackState.phase !== "battle" || fallbackState.status !== "active" || advice.action.kind !== "switch") return advice;
  if (isValidActiveSwitchCandidate(fallbackState, advice.action)) return advice;
  const fallbackAction = candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch") ?? {
    kind: "note" as const,
    command: "選出確認",
    reason: "選出していないポケモンへの交代が返ったため、操作指示を止めました。",
    risk: "選出済みの3体から技か交代先を選び直す必要があります。",
    confidence: "low" as const
  };
  return {
    ...advice,
    updatedState: fallbackState,
    action: fallbackAction,
    speech:
      fallbackAction.kind === "note"
        ? "選出していないポケモンへの交代になっていたので、操作指示はいったん止めます。"
        : `さっきの交代指示は選出と合わないので、ここは${fallbackAction.command}に修正します。${fallbackAction.reason}`,
    memo: fallbackAction.reason
  };
}

function repairOutOfCandidateBattleAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  if (fallbackState.phase !== "battle" || fallbackState.status !== "active") return advice;
  if (advice.action.kind !== "move" && advice.action.kind !== "switch") return advice;
  const candidateMatch = candidates.some(
    (candidate) => candidate.kind === advice.action.kind && candidate.command === advice.action.command
  );
  if (candidateMatch) return advice;
  const fallbackAction = candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch");
  if (!fallbackAction) return advice;
  return {
    ...advice,
    updatedState: fallbackState,
    action: fallbackAction,
    speech: `ここは${fallbackAction.command}にします。${fallbackAction.reason}`,
    memo: fallbackAction.reason
  };
}

function isSelectionLikeBattleSpeech(speech: string, state: BattleState): boolean {
  const normalized = speech.replace(/\s+/g, "");
  if (/(先発は|対戦よろしくお願いします|選出)/.test(normalized)) return true;
  const mentionedOwnNames = state.ownTeam.filter((pokemon) => pokemon.name && normalized.includes(pokemon.name)).length;
  return mentionedOwnNames >= 3 && /(ここは|でいきましょう|で行きましょう)/.test(normalized);
}

function battleSpeechForAction(action: CandidateAction): string {
  if (action.kind === "move") return `ここは${action.command}でいきましょう。${action.reason}`;
  if (action.kind === "switch") return `ここは${action.command}を出しましょう。${action.reason}`;
  return "対戦中なので、いまの盤面の確認として扱います。";
}

function repairSelectionLikeBattleSpeech(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  if (fallbackState.phase !== "battle" || fallbackState.status !== "active") return advice;
  if (!isSelectionLikeBattleSpeech(advice.speech, fallbackState)) return advice;
  const fallbackAction =
    candidates.find((candidate) => candidate.kind === advice.action.kind && candidate.command === advice.action.command) ??
    candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch") ??
    candidates.find((candidate) => candidate.kind === "note");
  return {
    ...advice,
    updatedState: fallbackState,
    ...(fallbackAction ? { action: fallbackAction } : {}),
    speech: fallbackAction ? battleSpeechForAction(fallbackAction) : "対戦中なので、いまの盤面の確認として扱います。",
    memo: fallbackAction?.reason ?? advice.memo
  };
}

export function repairInvalidBattleAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  if (fallbackState.phase === "battle" && fallbackState.status === "active" && advice.action.kind === "selection") {
    const fallbackAction = candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch") ??
      candidates.find((candidate) => candidate.kind === "note") ?? {
        kind: "note" as const,
        command: "状況確認",
        reason: "対戦中に選出指示が返ったため、対戦状態を維持して確認に戻しました。",
        risk: "盤面説明をもう一度入れると精度が上がります。",
        confidence: "low" as const
      };
    return {
      ...advice,
      updatedState: fallbackState,
      action: fallbackAction,
      speech:
        fallbackAction.kind === "note"
          ? "対戦中なので、いまの盤面の確認として扱います。"
          : battleSpeechForAction(fallbackAction),
      memo: fallbackAction.reason
    };
  }
  const activeMoveAdvice = repairInvalidActiveMoveAdvice(advice, fallbackState, candidates);
  if (activeMoveAdvice !== advice) return activeMoveAdvice;
  const activeSwitchAdvice = repairInvalidActiveSwitchAdvice(advice, fallbackState, candidates);
  if (activeSwitchAdvice !== advice) return activeSwitchAdvice;
  const outOfCandidateAdvice = repairOutOfCandidateBattleAdvice(advice, fallbackState, candidates);
  if (outOfCandidateAdvice !== advice) return outOfCandidateAdvice;
  const battleNoteAdvice = repairBattleNoteAdvice(advice, fallbackState, candidates);
  if (battleNoteAdvice !== advice) return battleNoteAdvice;
  const speechAdvice = repairSelectionLikeBattleSpeech(advice, fallbackState, candidates);
  if (speechAdvice !== advice) return speechAdvice;
  if (fallbackState.phase !== "battle" || advice.action.kind !== "selection") return advice;
  const fallbackAction = candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch") ??
    candidates.find((candidate) => candidate.kind !== "selection") ?? {
    kind: "note" as const,
    command: "状況確認",
    reason: "対戦中に選出指示が返ったため、対戦状態を維持して確認に戻しました。",
    risk: "盤面説明をもう一度入れると精度が上がります。",
    confidence: "low" as const
  };
  return {
    ...advice,
    updatedState: fallbackState,
    action: fallbackAction,
    speech:
      fallbackAction.kind === "note"
        ? "対戦中なので、いまの盤面の確認として扱います。"
        : battleSpeechForAction(fallbackAction),
    memo: advice.memo || fallbackAction.reason
  };
}

export function createBattleAdviceWorkflow(deps: BattleAdviceWorkflowDeps) {
  const store = createLocalDataStore(deps.championsDataDir);
  const pokemonLookup = createPokemonLookupTool(store);
  const moveLookup = createMoveLookupTool(store);
  const damageCalc = createDamageCalcTool(store);
  const model = toMastraModel(deps.adviceModel);
  const sharedProviderOptions = providerOptions(deps.adviceReasoningEffort);

  const extractBattleFactsAgent = new Agent({
    id: "extractBattleFactsAgent",
    name: "Extract Battle Facts Agent",
    model,
    tools: { pokemonLookup, moveLookup },
    instructions: [
      "あなたはPokemon Champions対戦ログの事実抽出器です。",
      "判断や助言はせず、入力文から事実だけを構造化してください。",
      "こちらの6体に存在しないポケモン名は、原則として相手側情報として扱ってください。",
      "不明な情報を確定扱いしないでください。"
    ].join("\n")
  });

  const generateCandidatesAgent = new Agent({
    id: "generateCandidatesAgent",
    name: "Generate Battle Candidates Agent",
    model,
    tools: { pokemonLookup, moveLookup, damageCalc },
    instructions: [
      "あなたはPokemon Championsの候補手生成エージェントです。",
      "自分側の6体、相手情報、ダメージ計算を見て、妥当な次アクション候補を短く作ってください。",
      "最終決定は別エージェントが行うため、候補以外の説明は不要です。"
    ].join("\n")
  });

  const chooseFinalActionAgent = new Agent({
    id: "chooseFinalActionAgent",
    name: "Choose Final Battle Action Agent",
    model,
    instructions: [
      "あなたはAIニケちゃん。Pokemon Championsの対戦パートナーとして、マスターの発話に応じて選出、次の一手、確認応答を返します。",
      "選出画面では自分の6体から3体を選び、ownTeamは6体すべて保持してください。",
      "対戦相談では、候補を比較して最終的な1手に絞ってください。",
      "会話や記憶では、マスターが待機、確認、報告、実行宣言をしているだけなら、技指示を繰り返さず action.kind = note で短く受けてください。"
    ].join("\n")
  });

  const extractMemoryNotesAgent = new Agent({
    id: "extractMemoryNotesAgent",
    name: "Extract Conversation Memory Notes Agent",
    model,
    instructions: [
      "あなたはAIニケちゃんの長期記憶管理エージェントです。",
      "会話から今後役立つ情報だけを短い独立メモとして抽出してください。",
      "一時的な盤面情報や重複情報は保存しないでください。"
    ].join("\n")
  });

  const normalizeInputStep = createStep({
    id: "normalizeInput",
    inputSchema: workflowInputSchema,
    outputSchema: normalizedPayloadSchema,
    execute: async ({ inputData }) => ({
      state: normalizeBattleState(inputData.state),
      transcript: inputData.transcript.trim(),
      traceId: crypto.randomUUID(),
      teamDoc: compactTeamDoc(deps.readTeamDoc()),
      timings: {},
      memoryContext: inputData.memoryContext,
      conversationIntent: inputData.conversationIntent
    })
  });

  const extractFactsStep = createStep({
    id: "extractBattleFacts",
    inputSchema: normalizedPayloadSchema,
    outputSchema: factsPayloadSchema,
    execute: async ({ inputData }) => {
      return timed(inputData, "extractBattleFacts", async () => {
        if (speedComparisonCandidate(store, inputData.state, inputData.transcript)) {
          const facts = addTranscriptMentionedPokemon(
            battleFactsSchema.parse({
              notes: ["素早さ比較の確認質問"]
            }),
            inputData.state,
            inputData.transcript,
            store
          );
          return { ...inputData, facts };
        }
        const result = await generateObjectWithRetry(
          () =>
            extractBattleFactsAgent.generate(buildFactsPrompt(inputData.state, inputData.transcript), {
              maxSteps: 2,
              abortSignal: timeoutSignal(deps.requestTimeoutMs, deps.abortSignal),
              providerOptions: sharedProviderOptions,
              structuredOutput: {
                schema: battleFactsLooseSchema,
                jsonPromptInjection: true,
                providerOptions: sharedProviderOptions
              }
            }),
          deps.abortSignal,
          "extractBattleFacts"
        );
        // 抽出に失敗しても、発話中のポケモン名はローカル照合(addTranscriptMentionedPokemon)で拾えるため
        // 空のfactsで続行し、対戦相談そのものは途切れさせない。
        const rawFactsObject = result?.object ?? { notes: ["構造化出力に失敗したため、この発話の事実抽出をスキップ"] };
        const extractedFacts = battleFactsSchema.parse(normalizeBattleFactsInput(rawFactsObject));
        const enrichedFacts = applyKnownMoveSideEffectFacts(
          applyOpponentSurvivalItemFacts(extractedFacts, inputData.transcript, inputData.state),
          inputData.transcript,
          inputData.state,
          store
        );
        const facts = addTranscriptMentionedPokemon(
          canonicalizeBattleFacts(enrichedFacts, store),
          inputData.state,
          inputData.transcript,
          store
        );
        return { ...inputData, facts };
      });
    }
  });

  const resolveNamesStep = createStep({
    id: "resolveNames",
    inputSchema: factsPayloadSchema,
    outputSchema: resolvedPayloadSchema,
    execute: async ({ inputData }) => {
      const names = new Set<string>();
      for (const name of [
        ...inputData.facts.opponentMentionedPokemon,
        ...inputData.facts.opponentSelectedPokemon,
        ...inputData.facts.ownMentionedPokemon,
        ...inputData.facts.ownSelectedPokemon,
        ...inputData.facts.faintedPokemon.map((pokemon) => pokemon.pokemon),
        inputData.facts.activeOwn,
        inputData.facts.activeOpponent
      ]) {
        if (name) names.add(name);
      }
      const resolvedNames: Record<string, string | null> = {};
      for (const name of names) {
        resolvedNames[name] = store.resolvePokemonId(name);
      }
      for (const move of inputData.facts.revealedMoves) {
        resolvedNames[move.move] = store.resolveMoveId(move.move);
      }
      for (const request of inputData.facts.damageCalcRequests) {
        if (request.attacker) resolvedNames[request.attacker] = store.resolvePokemonId(request.attacker);
        if (request.defender) resolvedNames[request.defender] = store.resolvePokemonId(request.defender);
        if (request.move) resolvedNames[request.move] = store.resolveMoveId(request.move);
      }
      return {
        ...inputData,
        resolvedNames,
        localKnowledge: buildLocalKnowledge(store, inputData.state, inputData.facts, deps.championsDataDir)
      };
    }
  });

  const updateStateStep = createStep({
    id: "updateBattleState",
    inputSchema: resolvedPayloadSchema,
    outputSchema: updatedPayloadSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      updatedState: applyFactsToState(inputData.state, inputData.facts, store),
      damageCalcs: []
    })
  });

  const damageCalcStep = createStep({
    id: "damageCalc",
    inputSchema: updatedPayloadSchema,
    outputSchema: updatedPayloadSchema,
    execute: async ({ inputData }) => {
      const damageCalcs = [];
      for (const request of inputData.facts.damageCalcRequests) {
        if (!request.attacker || !request.defender || !request.move) continue;
        try {
          damageCalcs.push(calculateLocalDamage(store, {
            attacker: request.attacker,
            defender: request.defender,
            move: request.move
          }));
        } catch (error) {
          damageCalcs.push({ error: String(error), request });
        }
      }
      return { ...inputData, damageCalcs };
    }
  });

  const generateCandidatesStep = createStep({
    id: "generateCandidates",
    inputSchema: updatedPayloadSchema,
    outputSchema: candidatesPayloadSchema,
    execute: async ({ inputData }) => {
      return timed(inputData, "generateCandidates", async () => {
        const speedCandidate = speedComparisonCandidate(store, inputData.updatedState, inputData.transcript);
        if (speedCandidate) {
          return {
            ...inputData,
            candidates: [speedCandidate],
            candidateToolCalls: []
          };
        }
        const isFastBattleTurn =
          inputData.conversationIntent === "battle" &&
          inputData.updatedState.phase === "battle" &&
          inputData.updatedState.status === "active";
        if (isFastBattleTurn) {
          const replacementCandidates = localReplacementCandidates(inputData.updatedState).slice(0, 5);
          if (replacementCandidates.length > 0) {
            return {
              ...inputData,
              candidates: replacementCandidates,
              candidateToolCalls: []
            };
          }
          const localCandidates = withoutDominatedMoveCandidates(
            inputData.updatedState,
            withLocalSwitchCandidate(store, inputData.updatedState, localActiveMoveCandidates(store, inputData.updatedState))
          ).slice(0, 5);
          if (localCandidates.length > 0) {
            return {
              ...inputData,
              candidates: localCandidates,
              candidateToolCalls: []
            };
          }
        }
        const result = await generateObjectWithRetry(
          () =>
            generateCandidatesAgent.generate(buildCandidatesPrompt(inputData), {
              maxSteps: 2,
              abortSignal: timeoutSignal(deps.requestTimeoutMs, deps.abortSignal),
              providerOptions: sharedProviderOptions,
              structuredOutput: {
                schema: z.object({
                  candidates: z.array(candidateActionSchema).min(1).max(5)
                }),
                jsonPromptInjection: true,
                providerOptions: sharedProviderOptions
              }
            }),
          deps.abortSignal,
          "generateCandidates"
        );
        if (!result) {
          // 候補生成に失敗した場合はローカル計算の候補で続行し、それも無ければ確認noteに落とす。
          const fallbackCandidates = withoutDominatedMoveCandidates(
            inputData.updatedState,
            withLocalSwitchCandidate(store, inputData.updatedState, localActiveMoveCandidates(store, inputData.updatedState))
          ).slice(0, 5);
          return {
            ...inputData,
            candidates:
              fallbackCandidates.length > 0
                ? fallbackCandidates
                : [
                    {
                      kind: "note" as const,
                      command: "状況確認",
                      reason: "候補生成に失敗したため、いまの盤面の確認として扱います。",
                      risk: "もう一度盤面を教えてもらえると次の一手を出せます。",
                      confidence: "low" as const
                    }
                  ],
            candidateToolCalls: []
          };
        }
        const moveAwareCandidates = withoutDominatedMoveCandidates(
          inputData.updatedState,
          withLocalMoveCandidates(
            store,
            inputData.updatedState,
            withMoveMatchups(
              store,
              inputData.updatedState,
              sanitizeBattleCandidates(inputData.updatedState, result.object.candidates)
            )
          )
        );
        const candidates = withLocalSwitchCandidate(store, inputData.updatedState, moveAwareCandidates).slice(0, 5);
        return {
          ...inputData,
          candidates,
          candidateToolCalls: result.toolCalls ?? []
        };
      });
    }
  });

  const decideActionStep = createStep({
    id: "chooseFinalAction",
    inputSchema: candidatesPayloadSchema,
    outputSchema: advicePayloadSchema,
    execute: async ({ inputData }) => {
      return timed(inputData, "chooseFinalAction", async () => {
        const speedCandidate = inputData.candidates.find(isSpeedComparisonCandidate);
        if (speedCandidate) {
          const advice: AdviceResult = {
            updatedState: normalizeBattleState(inputData.updatedState),
            action: speedCandidate,
            speech: speedComparisonSpeech(speedCandidate),
            memo: speedCandidate.reason
          };
          return {
            ...inputData,
            advice,
            decisionToolCalls: []
          };
        }
        const result = await generateObjectWithRetry(
          () =>
            chooseFinalActionAgent.generate(buildDecisionPrompt(inputData), {
              maxSteps: 1,
              abortSignal: timeoutSignal(deps.requestTimeoutMs, deps.abortSignal),
              providerOptions: sharedProviderOptions,
              structuredOutput: {
                schema: finalDecisionSchema,
                jsonPromptInjection: true,
                providerOptions: sharedProviderOptions
              }
            }),
          deps.abortSignal,
          "chooseFinalAction"
        );
        if (!result) {
          // 最終判断に失敗した場合は候補の先頭(技・交代優先)をそのまま採用する。
          // 選出フェーズの整形やphaseガードは後段のguardAdviceStepが修復する。
          const fallbackAction =
            inputData.candidates.find((candidate) => candidate.kind === "move" || candidate.kind === "switch") ??
            inputData.candidates[0] ?? {
              kind: "note" as const,
              command: "状況確認",
              reason: "最終判断に失敗したため、いまの盤面の確認として扱います。",
              risk: "もう一度盤面を教えてもらえると次の一手を出せます。",
              confidence: "low" as const
            };
          const advice: AdviceResult = {
            updatedState: normalizeBattleState(inputData.updatedState),
            action: fallbackAction,
            speech:
              fallbackAction.kind === "note"
                ? "うまく判断をまとめられなかったので、もう一度いまの盤面を教えてください。"
                : battleSpeechForAction(fallbackAction),
            memo: fallbackAction.reason
          };
          return {
            ...inputData,
            advice,
            decisionToolCalls: []
          };
        }
        const decision = finalDecisionSchema.parse(result.object);
        const selectedFromCommand = extractCommandOwnNames(decision.action.command, inputData.updatedState.ownTeam.map((pokemon) => pokemon.name));
        const selectedOwnPokemon = decision.selectedOwnPokemon?.length === 3 ? decision.selectedOwnPokemon : selectedFromCommand;
        const updatedState =
          inputData.updatedState.phase === "selection" && decision.action.kind === "selection" && selectedOwnPokemon.length === 3
            ? normalizeBattleState({
                ...inputData.updatedState,
                activeOwn: selectedOwnPokemon[0],
                ownTeam: inputData.updatedState.ownTeam.map((pokemon) => ({
                  ...pokemon,
                  selected: selectedOwnPokemon.includes(pokemon.name),
                  active: pokemon.name === selectedOwnPokemon[0]
                }))
              })
            : normalizeBattleState(inputData.updatedState);
        const advice: AdviceResult = {
          updatedState,
          action: decision.action,
          speech: decision.speech,
          memo: decision.memo
        };
        return {
          ...inputData,
          advice,
          decisionToolCalls: result.toolCalls ?? []
        };
      });
    }
  });

  const guardAdviceStep = createStep({
    id: "guardAdvice",
    inputSchema: memoryNotesPayloadSchema,
    outputSchema: workflowOutputSchema,
    execute: async ({ inputData }) => {
      const noteMode = inputData.conversationIntent !== "battle" || inputData.updatedState.status === "review";
      const baseAdvice = noteMode
        ? repairPositiveFeedbackAdvice(
            repairExecutionAcknowledgementAdvice(
              repairNoteModeAdvice(inputData.advice, inputData.updatedState, "会話または反省会として扱いました。"),
              inputData.updatedState,
              inputData.transcript
            ),
            inputData.updatedState,
            inputData.transcript
          )
        : inputData.advice;
      const guardedAdvice = noteMode
        ? baseAdvice
        : repairInvalidBattleAdvice(baseAdvice, inputData.updatedState, inputData.candidates);
      const errors = noteMode ? [] : validateSelectionAdvice(guardedAdvice);
      const repaired = noteMode || errors.length > 0;
      const advice = errors.length > 0 ? repairSelectionAdvice(guardedAdvice, inputData.updatedState, inputData.candidates) : guardedAdvice;
      const sanitizedAdvice = {
        ...advice,
        speech: sanitizeSpeechForVoice(advice.speech)
      };
      const finalErrors = noteMode ? [] : validateSelectionAdvice(sanitizedAdvice);
      const factsWarnings = detectFactsAnomalies(inputData.updatedState, inputData.facts, inputData.resolvedNames);
      const output = {
        ...sanitizedAdvice,
        model: deps.adviceModel,
        workflowTraceId: inputData.traceId,
        workflowTrace: {
          facts: inputData.facts,
          resolvedNames: inputData.resolvedNames,
          damageCalcs: inputData.damageCalcs,
          timings: inputData.timings,
          localKnowledge: inputData.localKnowledge,
          memoryContext: inputData.memoryContext,
          memoryNotes: inputData.memoryNotes,
          conversationIntent: inputData.conversationIntent,
          candidates: inputData.candidates,
          agentToolCalls: {
            candidates: inputData.candidateToolCalls,
            decision: inputData.decisionToolCalls
          },
          guard: {
            valid: finalErrors.length === 0,
            repaired,
            errors: finalErrors.length > 0 ? finalErrors : errors
          },
          factsWarnings
        }
      };
      console.info(
        `[battleAdviceWorkflow] trace=${inputData.traceId} timings=${JSON.stringify(inputData.timings)} totalModelMs=${Object.values(
          inputData.timings
        ).reduce((sum, value) => sum + value, 0)}`
      );
      if (factsWarnings.length > 0) {
        console.warn(`[battleAdviceWorkflow] trace=${inputData.traceId} factsWarnings=${JSON.stringify(factsWarnings)}`);
      }
      deps.appendBattleLog({
        createdAt: new Date().toISOString(),
        battleId: inputData.updatedState.battleId,
        transcript: inputData.transcript,
        workflowTraceId: inputData.traceId,
        workflowTrace: output.workflowTrace,
        result: advice
      });
      deps.appendMemoryNotes(
        inputData.memoryNotes.map((note) => ({
          ...note,
          sourceTranscript: inputData.transcript,
          battleId: inputData.updatedState.battleId
        }))
      );
      return output;
    }
  });

  const extractMemoryNotesStep = createStep({
    id: "extractMemoryNotes",
    inputSchema: advicePayloadSchema,
    outputSchema: memoryNotesPayloadSchema,
    execute: async ({ inputData }) => {
      return timed(inputData, "extractMemoryNotes", async () => {
        if (inputData.candidates.some(isSpeedComparisonCandidate)) {
          return {
            ...inputData,
            memoryNotes: []
          };
        }
        if (inputData.conversationIntent === "battle" && inputData.updatedState.status === "active") {
          return {
            ...inputData,
            memoryNotes: []
          };
        }
        const result = await extractMemoryNotesAgent.generate(buildMemoryExtractionPrompt(inputData), {
          maxSteps: 1,
          abortSignal: timeoutSignal(deps.requestTimeoutMs, deps.abortSignal),
          providerOptions: sharedProviderOptions,
          structuredOutput: {
            schema: z.object({
              notes: z.array(longTermMemoryNoteSchema).max(5)
            }),
            jsonPromptInjection: true,
            providerOptions: sharedProviderOptions
          }
        });
        throwIfAborted(deps.abortSignal);
        const memoryNotes = result.object.notes.map((note) => longTermMemoryNoteSchema.parse(note));
        return {
          ...inputData,
          memoryNotes
        };
      });
    }
  });

  return createWorkflow({
    id: "battleAdviceWorkflow",
    inputSchema: workflowInputSchema,
    outputSchema: workflowOutputSchema
  })
    .then(normalizeInputStep)
    .then(extractFactsStep)
    .then(resolveNamesStep)
    .then(updateStateStep)
    .then(damageCalcStep)
    .then(generateCandidatesStep)
    .then(decideActionStep)
    .then(extractMemoryNotesStep)
    .then(guardAdviceStep)
    .commit();
}

export async function runBattleAdviceWorkflow(deps: BattleAdviceWorkflowDeps, input: z.infer<typeof workflowInputSchema>) {
  const workflow = createBattleAdviceWorkflow(deps);
  const run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  if (result.status !== "success") {
    const stepErrors = Object.entries(result.steps ?? {})
      .filter(([, step]) => step.status === "failed")
      .map(([id, step]) => `${id}: ${step.status === "failed" ? step.error.message : "failed"}`);
    const detail = stepErrors.length > 0 ? ` (${stepErrors.join("; ")})` : "";
    throw new Error(`battleAdviceWorkflow failed: ${result.status}${detail}`);
  }
  return result.result;
}
