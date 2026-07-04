import fs from "node:fs";
import path from "node:path";

export interface LocalPokemon {
  id: string;
  name: string;
  types: string[];
  baseStats: Record<"hp" | "atk" | "def" | "spa" | "spd" | "spe", number>;
  abilities: Record<string, string>;
  isMega: boolean;
  aliasesJa: string[];
}

export type StatBoosts = Partial<Record<"atk" | "def" | "spa" | "spd" | "spe" | "accuracy" | "evasion", number>>;

export interface LocalMoveEffect {
  boosts?: StatBoosts;
  self?: {
    boosts?: StatBoosts;
  };
  status?: string;
  volatileStatus?: string;
  chance?: number;
}

export interface LocalMove {
  id: string;
  name: string;
  type: string;
  category: "Physical" | "Special" | "Status";
  basePower: number;
  accuracy: number | true;
  pp: number;
  priority: number;
  target: string;
  secondary: LocalMoveEffect | null;
  secondaries: LocalMoveEffect[] | null;
  boosts: StatBoosts | null;
  self: { boosts?: StatBoosts } | null;
  status: string | null;
  volatileStatus: string | null;
  forceSwitch: boolean | null;
  selfSwitch: string | boolean | null;
  isNonstandard: string | null;
  usableInChampions: boolean | null;
  championsAvailabilitySource: string | null;
  aliasesJa: string[];
}

export interface AliasTable {
  pokemon: Record<string, string[]>;
  moves: Record<string, string[]>;
  abilities: Record<string, string[]>;
  items: Record<string, string[]>;
}

export interface LocalDataStore {
  resolvePokemonId(name: string): string | null;
  resolveMoveId(name: string): string | null;
  getPokemon(nameOrId: string): LocalPokemon | null;
  listPokemon(): LocalPokemon[];
  getMove(nameOrId: string): LocalMove | null;
  listMoves(): LocalMove[];
}

function normalizeLookupKey(value: string): string {
  return foldKatakanaToHiragana(
    value
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[・\s._'-]/g, "")
  );
}

// 音声入力では同じ技名がカタカナ・ひらがなのどちらでも返るため(例: ナマケル / なまける)、
// 照合キーではカタカナをひらがなに畳み込んで表記ゆれを吸収する。長音符「ー」は
// カタカナ語で有意なため保持する。
function foldKatakanaToHiragana(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // カタカナ(ァ〜ヶ: U+30A1–U+30F6)のみを対応するひらがなへ変換する。
    if (code >= 0x30a1 && code <= 0x30f6) {
      result += String.fromCodePoint(code - 0x60);
    } else {
      result += char;
    }
  }
  return result;
}

function readJson<T>(dataDir: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8")) as T;
}

function resolveAlias(category: Record<string, string[]>, value: string): string | null {
  const key = normalizeLookupKey(value);
  for (const [id, aliases] of Object.entries(category)) {
    if (normalizeLookupKey(id) === key || aliases.some((alias) => normalizeLookupKey(alias) === key)) {
      return id;
    }
  }
  if (key.length >= 4) {
    let best: { id: string; distance: number } | null = null;
    for (const [id, aliases] of Object.entries(category)) {
      for (const alias of [id, ...aliases]) {
        const distance = levenshteinDistance(key, normalizeLookupKey(alias));
        if (!best || distance < best.distance) best = { id, distance };
      }
    }
    if (best && best.distance <= 1) return best.id;
  }
  return null;
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

export function createLocalDataStore(dataDir: string): LocalDataStore {
  const aliases = readJson<AliasTable>(dataDir, "ja-aliases.json");
  const pokemon = readJson<LocalPokemon[]>(dataDir, "pokemon.json");
  const moves = readJson<LocalMove[]>(dataDir, "moves.json");

  return {
    resolvePokemonId(name: string) {
      const alias = resolveAlias(aliases.pokemon, name);
      if (alias) return alias;
      const key = normalizeLookupKey(name);
      const direct = pokemon.find((entry) => entry.id === key || normalizeLookupKey(entry.name) === key)?.id ?? null;
      if (direct) return direct;
      // 「メガスターミー」のようにメガ進化が存在しない種名にメガが付いた場合(音声認識の
      // 産物など)は、メガ接頭辞と末尾のX/Yを外してベース種で引き直す。
      const trimmed = name.trim();
      if (trimmed.startsWith("メガ") && trimmed.length > 2) {
        const base = trimmed.slice(2).replace(/[XYxyｘｙＸＹ]$/, "").trim();
        if (base) return this.resolvePokemonId(base);
      }
      return null;
    },
    resolveMoveId(name: string) {
      const alias = resolveAlias(aliases.moves, name);
      if (alias) return alias;
      const key = normalizeLookupKey(name);
      return moves.find((entry) => entry.id === key || normalizeLookupKey(entry.name) === key)?.id ?? null;
    },
    getPokemon(nameOrId: string) {
      const id = this.resolvePokemonId(nameOrId);
      if (!id) return null;
      return pokemon.find((entry) => entry.id === id) ?? null;
    },
    listPokemon() {
      return pokemon;
    },
    getMove(nameOrId: string) {
      const id = this.resolveMoveId(nameOrId);
      if (!id) return null;
      return moves.find((entry) => entry.id === id) ?? null;
    },
    listMoves() {
      return moves;
    }
  };
}
