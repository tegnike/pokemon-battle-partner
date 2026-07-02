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
import { calculateLocalDamage } from "./damage";
import { createLocalDataStore, type LocalDataStore, type LocalPokemon } from "./localData";
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

const candidateActionSchema = z.object({
  kind: z.enum(["selection", "move", "switch", "note"]),
  command: z.string(),
  reason: z.string(),
  risk: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
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
- アシレーヌ: げきりゅう / たつじんのおび / うたかたのアリア・ムーンフォース・れいとうビーム・エナジーボール
- メタグロス: クリアボディ / メタグロスナイト / アイアンヘッド・バレットパンチ・アームハンマー・かみなりパンチ
- ウォッシュロトム: ふゆう / たべのこし / ハイドロポンプ・10まんボルト・おにび・ボルトチェンジ
- マスカーニャ: へんげんじざい / いのちのたま / トリックフラワー・はたきおとす・トリプルアクセル・ふいうち
- サザンドラ: ふゆう / こだわりスカーフ / りゅうせいぐん・あくのはどう・かえんほうしゃ・だいちのちから

基本方針:
- 基本選出はガブリアス、アシレーヌ、メタグロス。
- ライチュウ、特にメガライチュウYが見えたらガブリアスを厚めに見る。
- 雨ラグ展開はウォッシュロトム、アシレーヌ、マスカーニャを優先。
- ラグラージやカバルドンにはマスカーニャ、アシレーヌの草打点。
- アーマーガア、ペリッパー、水飛行にはウォッシュロトムやメタグロスのかみなりパンチ。
- ブリジュラスはガブリアスのじしん、メタグロスのアームハンマー、サザンドラのだいちのちから、アシレーヌのムーンフォースで見る。
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
  const local = localPokemonForName(store, pokemon.name);
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
    field: typeof object.field === "string" ? object.field.trim() : undefined,
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

function addTranscriptMentionedPokemon(facts: BattleFacts, state: BattleState, transcript: string): BattleFacts {
  const ownMentioned = mentionedOwnNamesFromText(state, transcript);
  const opponentMentioned = mentionedOpponentNamesFromText(state, transcript);
  if (ownMentioned.length === 0 && opponentMentioned.length === 0) return facts;
  const ownSet = new Set(ownMentioned);
  return {
    ...facts,
    ownMentionedPokemon: uniqueNames([...facts.ownMentionedPokemon, ...ownMentioned]),
    opponentMentionedPokemon: uniqueNames([
      ...facts.opponentMentionedPokemon.filter((name) => !ownSet.has(name)),
      ...opponentMentioned
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

function findPokemon(team: PokemonState[], name: string): PokemonState | undefined {
  return team.find((pokemon) => pokemon.name === name || pokemon.id === name);
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

function sanitizeBattleCandidates(state: BattleState, candidates: CandidateAction[]): CandidateAction[] {
  if (state.phase !== "battle" || state.status !== "active") return candidates;
  const safeCandidates = candidates.filter((candidate) => candidate.kind !== "selection" && isValidActiveMoveCandidate(state, candidate));
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
  const emptyIndex = state.opponentTeam.findIndex((pokemon) => !pokemon.name);
  if (emptyIndex < 0) return state;
  const next = [...state.opponentTeam];
  next[emptyIndex] = { ...createPokemon(`opp-${emptyIndex + 1}`, name), notes: "音声入力から確認" };
  return { ...state, opponentTeam: next };
}

function updateTeamPokemon(team: PokemonState[], name: string, update: (pokemon: PokemonState) => PokemonState) {
  return team.map((pokemon) => (pokemon.name === name || pokemon.id === name ? update(pokemon) : pokemon));
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

function applyFactsToState(state: BattleState, rawFacts: BattleFacts, store: LocalDataStore): BattleState {
  const megaEvolutions = collectMegaEvolutions(store, megaCandidateNamesFromFacts(rawFacts));
  const ownMegaEvolutions = collectMegaEvolutions(store, ownMegaCandidateNamesFromFacts(rawFacts));
  const facts = rewriteOwnMegaFactReferences(rewriteOpponentMegaFactReferences(rawFacts, megaEvolutions), ownMegaEvolutions);
  let next = applyOwnMegaEvolutions(applyOpponentMegaEvolutions({ ...state }, megaEvolutions), ownMegaEvolutions);
  if (facts.phase) next.phase = facts.phase;
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
    const selected = new Set(facts.ownSelectedPokemon);
    next.ownTeam = next.ownTeam.map((pokemon) => ({ ...pokemon, selected: selected.has(pokemon.name) }));
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
    next.activeOpponent = facts.activeOpponent;
    next.opponentTeam = next.opponentTeam.map((pokemon) => ({
      ...pokemon,
      active: pokemon.name === facts.activeOpponent,
      selected: pokemon.selected || pokemon.name === facts.activeOpponent
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
      next.activeOpponent = replacement;
      next.opponentTeam = next.opponentTeam.map((pokemon) => ({
        ...pokemon,
        active: pokemon.name === replacement,
        selected: pokemon.selected || pokemon.name === replacement
      }));
    }
  }

  for (const status of facts.statuses) {
    const target = status.side === "own" ? "ownTeam" : "opponentTeam";
    next = {
      ...next,
      [target]: updateTeamPokemon(next[target], status.pokemon, (pokemon) => ({
        ...pokemon,
        condition: status.condition
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
- 相手のパーティ6体、見せ合い6体、「相手のポケモンは...」は opponentMentionedPokemon に入れる。opponentSelectedPokemon には入れない。
- opponentSelectedPokemon は「相手の選出はA/B/C」「初手A」「Aを出してきた」「裏からB」「2体目B」など、実際の選出・場に出たことが明示された場合だけ入れる。
- ownMentionedPokemon は「私のA」「こちらのA」「AはBより速い/遅いか」など、こちらの6体に含まれるポケモンが話題に出た場合に入れる。選出確定とは別扱いにする。
- 6体すべてを opponentSelectedPokemon に入れてはいけない。明示された選出3体でない限り、最大でも今回新しく場に出たポケモンだけにする。
- 「初手A」「Aを投げてきた」「Aを出してきた」「裏からA」は activeOpponent にもAを入れる。
- 相手が「メガA」に進化した、または「メガA」と判明した場合は、以後その相手ポケモン名をメガAとして扱い、revealedItem に item="メガストーン" confirmed を入れる。
- 「Aを倒した」「Aを倒せた」「Aを落とした」「Aがひんし」は faintedPokemon に入れ、side は相手を倒したなら opponent、自分が倒されたなら own。
- 相手が「きあいのタスキ」「気合のタスキ」「きあいのハチマキ」などで持ちこたえた/耐えた場合は、相手側 hpUpdates に hpPercent=1 を入れ、revealedItem にその持ち物を confirmed で入れる。
- 天気、フィールド、追い風、壁、ステルスロック、まきびしなど場に残る情報は field に短く追記できる形で入れる。
- 「Aの素早さが上がった」「S+1」「Aの攻撃が下がった」など能力ランク変化は statChanges に入れる。pokemon は対象、changes は「素早さ+1」「攻撃-1」など短く書く。
- 確定していない技・特性・持ち物は suspected、発話で明確なら confirmed。
- 雑談や対戦に無関係な話は、notes に短く残し、対戦stateを無理に更新しない。
- 分からない項目は空配列または省略。
- JSON以外は返さない。

会話記憶:
${state.history.length > 0 ? state.history.slice(-5).map((entry) => `- ${entry.transcript} => ${entry.action}`).join("\n") : "なし"}

現在state:
${JSON.stringify(state)}

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
- ダメージ計算結果がある場合は必ず候補理由に反映する。
- 雑談や記憶してほしい話題なら、kind は note にして自然な返答候補を作る。
- ポケモン別ナレッジは見出しに書かれたポケモン専用。現在対面やリスク説明で別ポケモンのナレッジを流用しない。
- 素早さ・先手後手の確認では、必ず「素早さ比較用データ」の ownKnownSpeed / maxUnboostedSpeed / baseSpe を優先する。記憶や一般知識だけで速い・遅いを断定しない。

こちらの構築メモ:
${payload.teamDoc}

会話記憶:
${limitText(payload.memoryContext || "なし", 3000)}

抽出済み事実:
${JSON.stringify(payload.facts, null, 2)}

解決済み名前:
${JSON.stringify(payload.resolvedNames, null, 2)}

ローカルポケモンデータ:
${payload.localKnowledge}

ダメージ計算:
${JSON.stringify(payload.damageCalcs, null, 2)}

現在state:
${JSON.stringify(compactStateForPrompt(payload.updatedState), null, 2)}

マスターの最新説明:
${payload.transcript}
`;
}

function buildDecisionPrompt(payload: z.infer<typeof candidatesPayloadSchema>): string {
  const ownNames = payload.updatedState.ownTeam.map((pokemon) => pokemon.name).join(" / ");
  return `
あなたはAIニケちゃん。Pokemon Championsのシングル対戦で、マスターが実際に操作し、あなたは状況に応じて選出・次の一手・確認応答を返す。

会話intent: ${payload.conversationIntent}
対戦相手名: ${payload.updatedState.opponentName || "未設定"}
対戦ステータス: ${payload.updatedState.status}

絶対ルール:
- 会話intent が chat または memory の場合は、必ず action.kind = "note" にして、選出・技・交代の新規指示を出さない。
- 対戦ステータスが review の場合は、勝敗・選出・分岐・次回改善点の反省会として返す。
- 会話intent が battle、対戦ステータスが active、現在phaseがbattleの場合は、対戦相談ボタン経由として扱い、短い盤面報告だけでも候補から技または交代の一手を返す。
- 対戦中にマスターが次の行動判断を求めている場合だけ、技または交代の一手を返す。
- マスターが確認、報告、待機、実行宣言をしているだけなら、action.kind = "note" で短く受ける。技指示を繰り返さない。
- 選出画面では ownTeam の6体から3体を選び、選んだ3体だけ selected: true にする。
- 選出画面の action.command は、必ずこちらの6体から選んだ3体名だけを「ポケモン名、ポケモン名、ポケモン名」の形式で返す。
- 選出画面の speech では、必ず「先発は〇〇」と先発ポケモンを明示する。先発は action.command の1体目として扱う。
- 選出画面の speech は、必ず最後を「${payload.updatedState.opponentName ? `${payload.updatedState.opponentName.replace(/さん$/, "")}さん` : "対戦相手さん"}、対戦よろしくお願いします。」で締める。
- こちらの6体は ${ownNames} のみ。これ以外のポケモン名を action.command に入れてはいけない。
- ownTeam は絶対に3体へ削らず、6体すべてを保持する。
- ダメ計結果がある場合は必ず判断材料にする。
- 対戦に関係する確認質問でも、操作判断を求められていないなら action.kind = "note" で答える。
- マスターの好みや過去会話に関係する場合は、会話記憶を判断材料にする。
- speech はAIニケちゃんとしてマスターにそのまま話すセリフ。音声再生される前提で、自然な日本語1〜3文にする。
- speech には command だけでなく、「なぜそうするか」を短く含める。例: 「ペリッパーとラグラージの雨展開が見えるので、ここはガブリアス、アシレーヌ、メタグロスでいきましょう！」
- Pokemon Championsローカルデータを優先する。ローカルポケモンデータに書かれていないタイプ・特性・無効耐性を昔の知識で補完してはいけない。
- ポケモン別ナレッジは見出しに書かれたポケモン専用。現在対面やリスク説明で別ポケモンのナレッジを流用しない。
- 候補理由にローカルデータの型・特性・相性が書かれている場合、それと矛盾する説明をしてはいけない。
- 素早さ・先手後手の確認では、必ず「素早さ比較用データ」の ownKnownSpeed / maxUnboostedSpeed / baseSpe を優先する。記憶や一般知識だけで速い・遅いを断定しない。
- 返答はJSONだけ。Markdownや説明文を外に出さない。

こちらの構築メモ:
${payload.teamDoc}

会話記憶:
${limitText(payload.memoryContext || "なし", 3000)}

抽出済み事実:
${JSON.stringify(payload.facts, null, 2)}

解決済み名前:
${JSON.stringify(payload.resolvedNames, null, 2)}

ローカルポケモンデータ:
${payload.localKnowledge}

ダメージ計算:
${JSON.stringify(payload.damageCalcs, null, 2)}

候補:
${JSON.stringify(payload.candidates, null, 2)}

現在state:
${JSON.stringify(compactStateForPrompt(payload.updatedState), null, 2)}

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

function repairInvalidBattleAdvice(
  advice: AdviceResult,
  fallbackState: BattleState,
  candidates: CandidateAction[]
): AdviceResult {
  const activeMoveAdvice = repairInvalidActiveMoveAdvice(advice, fallbackState, candidates);
  if (activeMoveAdvice !== advice) return activeMoveAdvice;
  const battleNoteAdvice = repairBattleNoteAdvice(advice, fallbackState, candidates);
  if (battleNoteAdvice !== advice) return battleNoteAdvice;
  if (fallbackState.phase !== "battle" || advice.action.kind !== "selection") return advice;
  const fallbackAction = candidates.find((candidate) => candidate.kind !== "selection") ?? {
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
        ? "対戦中なので選出には戻さず、いまの盤面確認として扱います。"
        : `ここは${fallbackAction.command}でいきましょう。${fallbackAction.reason}`,
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
      "対戦中にマスターが次の行動を求めている場合は、候補を比較して最終的な1手に絞ってください。",
      "マスターが待機、確認、報告、実行宣言をしているだけなら、技指示を繰り返さず action.kind = note で短く受けてください。"
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
            inputData.transcript
          );
          return { ...inputData, facts };
        }
        const result = await extractBattleFactsAgent.generate(buildFactsPrompt(inputData.state, inputData.transcript), {
          maxSteps: 2,
          abortSignal: timeoutSignal(deps.requestTimeoutMs, deps.abortSignal),
          providerOptions: sharedProviderOptions,
          structuredOutput: {
            schema: battleFactsSchema,
            jsonPromptInjection: true,
            providerOptions: sharedProviderOptions
          }
        });
        throwIfAborted(deps.abortSignal);
        const extractedFacts = battleFactsSchema.parse(normalizeBattleFactsInput(result.object));
        const facts = addTranscriptMentionedPokemon(
          canonicalizeBattleFacts(applyOpponentSurvivalItemFacts(extractedFacts, inputData.transcript, inputData.state), store),
          inputData.state,
          inputData.transcript
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
        const result = await generateCandidatesAgent.generate(buildCandidatesPrompt(inputData), {
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
        });
        throwIfAborted(deps.abortSignal);
        const candidates = sanitizeBattleCandidates(inputData.updatedState, result.object.candidates);
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
        const result = await chooseFinalActionAgent.generate(buildDecisionPrompt(inputData), {
          maxSteps: 1,
          abortSignal: timeoutSignal(deps.requestTimeoutMs, deps.abortSignal),
          providerOptions: sharedProviderOptions,
          structuredOutput: {
            schema: finalDecisionSchema,
            jsonPromptInjection: true,
            providerOptions: sharedProviderOptions
          }
        });
        throwIfAborted(deps.abortSignal);
        const decision = finalDecisionSchema.parse(result.object);
        const selectedFromCommand = extractCommandOwnNames(decision.action.command, inputData.updatedState.ownTeam.map((pokemon) => pokemon.name));
        const selectedOwnPokemon = decision.selectedOwnPokemon?.length === 3 ? decision.selectedOwnPokemon : selectedFromCommand;
        const updatedState =
          decision.action.kind === "selection" && selectedOwnPokemon.length === 3
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
      const guardedAdvice = noteMode
        ? repairNoteModeAdvice(inputData.advice, inputData.updatedState, "会話または反省会として扱いました。")
        : repairInvalidBattleAdvice(inputData.advice, inputData.updatedState, inputData.candidates);
      const errors = noteMode ? [] : validateSelectionAdvice(guardedAdvice);
      const repaired = noteMode || errors.length > 0;
      const advice = errors.length > 0 ? repairSelectionAdvice(guardedAdvice, inputData.updatedState, inputData.candidates) : guardedAdvice;
      const finalErrors = noteMode ? [] : validateSelectionAdvice(advice);
      const output = {
        ...advice,
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
          }
        }
      };
      console.info(
        `[battleAdviceWorkflow] trace=${inputData.traceId} timings=${JSON.stringify(inputData.timings)} totalModelMs=${Object.values(
          inputData.timings
        ).reduce((sum, value) => sum + value, 0)}`
      );
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
        return {
          ...inputData,
          memoryNotes: result.object.notes
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
