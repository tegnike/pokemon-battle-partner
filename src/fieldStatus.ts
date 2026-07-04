import type { BattleState, PokemonState } from "./domain";

export type FieldStatusGroupKey = "global" | "own" | "opponent" | "unknown";

export interface FieldStatusItem {
  label: string;
  detail: string;
  category: "weather" | "terrain" | "space" | "hazard" | "screen" | "side" | "pokemon" | "raw";
}

export interface BattleStatusSummary {
  global: FieldStatusItem[];
  own: FieldStatusItem[];
  opponent: FieldStatusItem[];
  unknown: FieldStatusItem[];
  pokemon: FieldStatusItem[];
  rawField: string;
}

interface FieldDefinition {
  label: string;
  category: FieldStatusItem["category"];
  scope: "global" | "side";
  patterns: RegExp[];
}

const fieldDefinitions: FieldDefinition[] = [
  {
    label: "晴れ",
    category: "weather",
    scope: "global",
    patterns: [/晴れ|にほんばれ|日差し|ひざし|sun/i]
  },
  {
    label: "雨",
    category: "weather",
    scope: "global",
    patterns: [/雨|あめ|rain/i]
  },
  {
    label: "砂嵐",
    category: "weather",
    scope: "global",
    patterns: [/砂嵐|すなあらし|sand/i]
  },
  {
    label: "雪",
    category: "weather",
    scope: "global",
    patterns: [/雪|ゆき|snow|あられ|hail/i]
  },
  {
    label: "強い日差し",
    category: "weather",
    scope: "global",
    patterns: [/おおひでり|強い日差し|とても強い日差し|harsh sunlight/i]
  },
  {
    label: "強い雨",
    category: "weather",
    scope: "global",
    patterns: [/おおあめ|強い雨|heavy rain/i]
  },
  {
    label: "乱気流",
    category: "weather",
    scope: "global",
    patterns: [/らんきりゅう|乱気流|strong winds/i]
  },
  {
    label: "エレキフィールド",
    category: "terrain",
    scope: "global",
    patterns: [/エレキフィールド|electric terrain/i]
  },
  {
    label: "グラスフィールド",
    category: "terrain",
    scope: "global",
    patterns: [/グラスフィールド|grassy terrain/i]
  },
  {
    label: "ミストフィールド",
    category: "terrain",
    scope: "global",
    patterns: [/ミストフィールド|misty terrain/i]
  },
  {
    label: "サイコフィールド",
    category: "terrain",
    scope: "global",
    patterns: [/サイコフィールド|psychic terrain/i]
  },
  {
    label: "トリックルーム",
    category: "space",
    scope: "global",
    patterns: [/トリックルーム|trick room/i]
  },
  {
    label: "ワンダールーム",
    category: "space",
    scope: "global",
    patterns: [/ワンダールーム|wonder room/i]
  },
  {
    label: "マジックルーム",
    category: "space",
    scope: "global",
    patterns: [/マジックルーム|magic room/i]
  },
  {
    label: "じゅうりょく",
    category: "space",
    scope: "global",
    patterns: [/じゅうりょく|重力|gravity/i]
  },
  {
    label: "ステルスロック",
    category: "hazard",
    scope: "side",
    patterns: [/ステルスロック|stealth rock/i]
  },
  {
    label: "まきびし",
    category: "hazard",
    scope: "side",
    patterns: [/まきびし|(?:^|[^a-z])spikes/i]
  },
  {
    label: "どくびし",
    category: "hazard",
    scope: "side",
    patterns: [/どくびし|toxic spikes/i]
  },
  {
    label: "ねばねばネット",
    category: "hazard",
    scope: "side",
    patterns: [/ねばねばネット|sticky web/i]
  },
  {
    label: "キョダイコウジン",
    category: "hazard",
    scope: "side",
    patterns: [/キョダイコウジン|g-max steelsurge/i]
  },
  {
    label: "リフレクター",
    category: "screen",
    scope: "side",
    patterns: [/リフレクター|reflect/i]
  },
  {
    label: "ひかりのかべ",
    category: "screen",
    scope: "side",
    patterns: [/ひかりのかべ|光の壁|light screen/i]
  },
  {
    label: "オーロラベール",
    category: "screen",
    scope: "side",
    patterns: [/オーロラベール|aurora veil/i]
  },
  {
    label: "おいかぜ",
    category: "side",
    scope: "side",
    patterns: [/おいかぜ|追い風|tailwind/i]
  },
  {
    label: "しんぴのまもり",
    category: "screen",
    scope: "side",
    patterns: [/しんぴのまもり|神秘の守り|safeguard/i]
  },
  {
    label: "しろいきり",
    category: "screen",
    scope: "side",
    patterns: [/しろいきり|白い霧|\bmist\b/i]
  },
  {
    label: "おまじない",
    category: "screen",
    scope: "side",
    patterns: [/おまじない|lucky chant/i]
  },
  {
    label: "にじ",
    category: "side",
    scope: "side",
    patterns: [/にじ|虹|rainbow/i]
  },
  {
    label: "ひのうみ",
    category: "side",
    scope: "side",
    patterns: [/ひのうみ|火の海|sea of fire/i]
  },
  {
    label: "しつげん",
    category: "side",
    scope: "side",
    patterns: [/しつげん|湿原|swamp/i]
  }
];

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim();
}

function fieldSegments(field: string): string[] {
  return normalizeText(field)
    .split(/\n|\/|、|，|,|。|；|;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function sideFromSegment(segment: string): "own" | "opponent" | "both" | null {
  const text = normalizeText(segment);
  const own = /自分|こちら|こっち|味方|自陣|自分側|こちら側|own|ally/i.test(text);
  const opponent = /相手|敵|相手側|相手の場|相手場|敵陣|向こう|opponent|enemy/i.test(text);
  if (own && opponent) return "both";
  if (own) return "own";
  if (opponent) return "opponent";
  if (/両方|双方|お互い|both/i.test(text)) return "both";
  return null;
}

function detailForSegment(segment: string, label: string, needsSide: boolean): string {
  const turn = segment.match(/\d+\s*ターン|[0-9]+\s*T/i)?.[0] ?? "";
  const layer = segment.match(/\d+\s*回|\d+\s*層/)?.[0] ?? "";
  const extras = [turn, layer].filter(Boolean).join(" / ");
  if (extras) return extras;
  const cleaned = segment
    .replace(label, "")
    .replace(/全体|自分側|こちら側|相手側|側不明|自分|こちら|相手|own|opponent|enemy|ally/gi, "")
    .replace(/[:：]/g, "")
    .trim();
  if (needsSide && !sideFromSegment(segment)) return `側不明: ${segment}`;
  return cleaned && cleaned.length <= 30 ? cleaned : "";
}

function addUnique(target: FieldStatusItem[], item: FieldStatusItem) {
  if (target.some((current) => current.label === item.label && current.detail === item.detail)) return;
  target.push(item);
}

function addToGroup(
  summary: BattleStatusSummary,
  group: FieldStatusGroupKey,
  definition: FieldDefinition,
  segment: string
) {
  addUnique(summary[group], {
    label: definition.label,
    detail: detailForSegment(segment, definition.label, definition.scope === "side"),
    category: definition.category
  });
}

function parseField(summary: BattleStatusSummary, field: string) {
  const segments = fieldSegments(field);
  const matchedSegments = new Set<string>();
  for (const segment of segments) {
    for (const definition of fieldDefinitions) {
      if (!definition.patterns.some((pattern) => pattern.test(segment))) continue;
      matchedSegments.add(segment);
      if (definition.scope === "global") {
        addToGroup(summary, "global", definition, segment);
        continue;
      }
      const side = sideFromSegment(segment);
      if (side === "both") {
        addToGroup(summary, "own", definition, segment);
        addToGroup(summary, "opponent", definition, segment);
      } else if (side === "own" || side === "opponent") {
        addToGroup(summary, side, definition, segment);
      } else {
        addToGroup(summary, "unknown", definition, segment);
      }
    }
  }

  for (const segment of segments) {
    if (matchedSegments.has(segment)) continue;
    addUnique(summary.unknown, {
      label: "その他",
      detail: segment,
      category: "raw"
    });
  }
}

function pokemonStatusItems(team: PokemonState[], sideLabel: string): FieldStatusItem[] {
  return team.flatMap((pokemon) => {
    if (!pokemon.name) return [];
    const details = [
      pokemon.condition ? `状態: ${pokemon.condition}` : "",
      pokemon.statChanges ? `能力: ${pokemon.statChanges}` : ""
    ].filter(Boolean);
    if (details.length === 0) return [];
    return [
      {
        label: `${sideLabel} ${pokemon.name}`,
        detail: details.join(" / "),
        category: "pokemon" as const
      }
    ];
  });
}

export function summarizeBattleStatus(state: BattleState): BattleStatusSummary {
  const summary: BattleStatusSummary = {
    global: [],
    own: [],
    opponent: [],
    unknown: [],
    pokemon: [],
    rawField: state.field.trim()
  };
  if (state.field.trim()) parseField(summary, state.field);
  summary.pokemon = [
    ...pokemonStatusItems(state.ownTeam, "自分"),
    ...pokemonStatusItems(state.opponentTeam, "相手")
  ];
  return summary;
}
