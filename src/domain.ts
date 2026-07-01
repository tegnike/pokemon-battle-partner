import { calculateChampionsStats, type BaseStats, type NatureModifiers, type StatPoints } from "./champions/statCalc";

export type KnowledgeStatus = "unknown" | "suspected" | "confirmed";

export type BattlePhase = "selection" | "battle";

export type BattleStatus = "active" | "review" | "closed";

export type Confidence = "high" | "medium" | "low";

export interface KnownValue {
  value: string;
  status: KnowledgeStatus;
}

export interface PokemonState {
  id: string;
  name: string;
  selected: boolean;
  active: boolean;
  hpPercent: number | null;
  currentHp: number | null;
  maxHp: number | null;
  condition: string;
  ability: KnownValue;
  item: KnownValue;
  moves: KnownValue[];
  statChanges: string;
  notes: string;
}

export interface TurnEntry {
  turn: number;
  transcript: string;
  action: string;
  memo: string;
  createdAt: string;
}

export interface BattleState {
  battleId: string;
  phase: BattlePhase;
  status: BattleStatus;
  opponentName: string;
  createdAt: string;
  updatedAt: string;
  turn: number;
  opponentTeam: PokemonState[];
  ownTeam: PokemonState[];
  activeOwn: string;
  activeOpponent: string;
  field: string;
  latestMemo: string;
  history: TurnEntry[];
}

export interface AdviceResult {
  updatedState: BattleState;
  action: {
    kind: "selection" | "move" | "switch" | "note";
    command: string;
    reason: string;
    risk: string;
    confidence: Confidence;
  };
  speech: string;
  memo: string;
}

export function emptyKnownValue(): KnownValue {
  return { value: "", status: "unknown" };
}

export function createPokemon(id: string, name = ""): PokemonState {
  return {
    id,
    name,
    selected: false,
    active: false,
    hpPercent: null,
    currentHp: null,
    maxHp: null,
    condition: "",
    ability: emptyKnownValue(),
    item: emptyKnownValue(),
    moves: [],
    statChanges: "",
    notes: ""
  };
}

function confirmed(value: string): KnownValue {
  return { value, status: "confirmed" };
}

function confirmedMoves(values: string[]): KnownValue[] {
  return values.map((value) => confirmed(value));
}

interface OwnBuild {
  id: string;
  name: string;
  ability: string;
  item: string;
  moves: string[];
  notes: string;
  baseStats: BaseStats;
  statPoints: StatPoints;
  nature: NatureModifiers;
}

function createOwnPokemon(build: OwnBuild): PokemonState {
  const stats = calculateChampionsStats({
    baseStats: build.baseStats,
    statPoints: build.statPoints,
    nature: build.nature
  });
  return {
    ...createPokemon(build.id, build.name),
    hpPercent: 100,
    currentHp: stats.hp,
    maxHp: stats.hp,
    ability: confirmed(build.ability),
    item: confirmed(build.item),
    moves: confirmedMoves(build.moves),
    notes: build.notes
  };
}

export function createOwnTeam(): PokemonState[] {
  return [
    createOwnPokemon({
      id: "own-garchomp",
      name: "ガブリアス",
      ability: "さめはだ",
      item: "きあいのタスキ",
      moves: ["じしん", "ドラゴンクロー", "がんせきふうじ", "ステルスロック"],
      notes: "ようき / A32 S32 B2",
      baseStats: { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 },
      statPoints: { atk: 32, spe: 32, def: 2 },
      nature: { plus: "spe", minus: "spa" }
    }),
    createOwnPokemon({
      id: "own-primarina",
      name: "アシレーヌ",
      ability: "げきりゅう",
      item: "たつじんのおび",
      moves: ["うたかたのアリア", "ムーンフォース", "れいとうビーム", "エナジーボール"],
      notes: "ひかえめ / H32 C32 B2",
      baseStats: { hp: 80, atk: 74, def: 74, spa: 126, spd: 116, spe: 60 },
      statPoints: { hp: 32, spa: 32, def: 2 },
      nature: { plus: "spa", minus: "atk" }
    }),
    createOwnPokemon({
      id: "own-metagross",
      name: "メタグロス",
      ability: "クリアボディ",
      item: "メタグロスナイト",
      moves: ["アイアンヘッド", "バレットパンチ", "アームハンマー", "かみなりパンチ"],
      notes: "ようき / A32 S32 B2",
      baseStats: { hp: 80, atk: 135, def: 130, spa: 95, spd: 90, spe: 70 },
      statPoints: { atk: 32, spe: 32, def: 2 },
      nature: { plus: "spe", minus: "spa" }
    }),
    createOwnPokemon({
      id: "own-rotom-wash",
      name: "ウォッシュロトム",
      ability: "ふゆう",
      item: "たべのこし",
      moves: ["ハイドロポンプ", "10まんボルト", "おにび", "ボルトチェンジ"],
      notes: "ずぶとい / H32 B32 C2",
      baseStats: { hp: 50, atk: 65, def: 107, spa: 105, spd: 107, spe: 86 },
      statPoints: { hp: 32, def: 32, spa: 2 },
      nature: { plus: "def", minus: "atk" }
    }),
    createOwnPokemon({
      id: "own-meowscarada",
      name: "マスカーニャ",
      ability: "へんげんじざい",
      item: "いのちのたま",
      moves: ["トリックフラワー", "はたきおとす", "トリプルアクセル", "ふいうち"],
      notes: "ようき / A24 S32 H2 B8",
      baseStats: { hp: 76, atk: 110, def: 70, spa: 81, spd: 70, spe: 123 },
      statPoints: { atk: 24, spe: 32, hp: 2, def: 8 },
      nature: { plus: "spe", minus: "spa" }
    }),
    createOwnPokemon({
      id: "own-hydreigon",
      name: "サザンドラ",
      ability: "ふゆう",
      item: "こだわりスカーフ",
      moves: ["りゅうせいぐん", "あくのはどう", "かえんほうしゃ", "だいちのちから"],
      notes: "ひかえめ / C32 S32 H2",
      baseStats: { hp: 92, atk: 105, def: 90, spa: 125, spd: 90, spe: 98 },
      statPoints: { spa: 32, spe: 32, hp: 2 },
      nature: { plus: "spa", minus: "atk" }
    })
  ];
}

function clampHpPercent(value: number | null | undefined, fallback: number | null): number | null {
  const target = value ?? fallback;
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.min(100, Math.round(target ?? 0)));
}

function currentHpFromPercent(maxHp: number | null, hpPercent: number | null): number | null {
  if (!maxHp || hpPercent === null) return null;
  return Math.max(0, Math.min(maxHp, Math.round((maxHp * hpPercent) / 100)));
}

function normalizeOpponentTeam(team: PokemonState[]): PokemonState[] {
  return team.map((pokemon) => ({
    ...pokemon,
    hpPercent: clampHpPercent(pokemon.hpPercent, 100),
    currentHp: pokemon.currentHp ?? null,
    maxHp: pokemon.maxHp ?? null
  }));
}

export function normalizeBattleState(input: unknown): BattleState {
  const initial = createInitialBattleState();
  if (!input || typeof input !== "object") return initial;
  const raw = input as Partial<BattleState> & { ownSelection?: PokemonState[] };
  const legacyOwn = Array.isArray(raw.ownTeam) ? raw.ownTeam : raw.ownSelection;
  const ownById = new Map((legacyOwn ?? []).map((pokemon) => [pokemon.id, pokemon]));
  const ownByName = new Map((legacyOwn ?? []).map((pokemon) => [pokemon.name, pokemon]));
  const ownTeam = createOwnTeam().map((pokemon) => {
    const saved = ownById.get(pokemon.id) ?? ownByName.get(pokemon.name);
    if (!saved) return pokemon;
    const hpPercent = clampHpPercent(saved.hpPercent, pokemon.hpPercent);
    const currentHp = typeof saved.currentHp === "number" ? saved.currentHp : currentHpFromPercent(pokemon.maxHp, hpPercent);
    const savedMegaMetagross = pokemon.id === "own-metagross" && saved.name === "メガメタグロス" && saved.ability?.value === "かたいツメ";
    return {
      ...pokemon,
      name: savedMegaMetagross ? saved.name : pokemon.name,
      selected: saved.selected,
      active: saved.active,
      hpPercent,
      currentHp,
      condition: saved.condition,
      ability: savedMegaMetagross ? saved.ability : pokemon.ability,
      statChanges: saved.statChanges,
      notes: saved.notes && saved.notes !== pokemon.notes ? `${pokemon.notes} / ${saved.notes}` : pokemon.notes
    };
  });
  const ownNames = new Set(ownTeam.map((pokemon) => pokemon.name));
  const activeOwn = typeof raw.activeOwn === "string" && ownNames.has(raw.activeOwn)
    ? raw.activeOwn
    : ownTeam.find((pokemon) => pokemon.active)?.name ?? initial.activeOwn;
  return {
    ...initial,
    ...raw,
    status: raw.status ?? initial.status,
    opponentName: typeof raw.opponentName === "string" ? raw.opponentName : initial.opponentName,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : initial.createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : initial.updatedAt,
    opponentTeam: normalizeOpponentTeam(Array.isArray(raw.opponentTeam) ? raw.opponentTeam : initial.opponentTeam),
    ownTeam,
    activeOwn,
    history: Array.isArray(raw.history) ? raw.history : []
  };
}

export function createInitialBattleState(opponentName = ""): BattleState {
  const now = new Date().toISOString();
  return {
    battleId: crypto.randomUUID(),
    phase: "selection",
    status: "active",
    opponentName,
    createdAt: now,
    updatedAt: now,
    turn: 0,
    opponentTeam: Array.from({ length: 6 }, (_, index) => ({
      ...createPokemon(`opp-${index + 1}`),
      hpPercent: 100
    })),
    ownTeam: createOwnTeam(),
    activeOwn: "",
    activeOpponent: "",
    field: "",
    latestMemo: "",
    history: []
  };
}
