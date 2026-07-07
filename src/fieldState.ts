// 構造化FieldState。
//
// これまで BattleState.field は自由文字列で、新しい観測が来るたびに全置換されていた。
// そのため「雨になった」という報告だけで、記録済みのステルスロックや壁の情報が消え得た。
// さらに同じ文字列を UI(fieldStatus.ts) と workflow内の独自正規表現が別々に解釈していた。
//
// このモジュールは field 文字列を唯一の定義テーブル(fieldStatus.ts の fieldDefinitions)で
// 構造化し、「観測のマージ」を決定的に行う:
//   - parseFieldState:     field文字列 → FieldState
//   - applyFieldObservation: 既存FieldState + 新しい観測文字列 → マージ済みFieldState
//   - serializeFieldState: FieldState → 正規形の field 文字列 (UIも読める規約で出力)
//   - mergeFieldText:      上記3つをまとめた「文字列 in/out」の入口
//
// BattleState.field の型は string のまま維持する。値を常に serializeFieldState の正規形へ
// 寄せることで、保存済みセッション・Zodスキーマ・UI表示の後方互換を保ったまま、
// 上書きによる情報喪失だけを取り除く。
import {
  type FieldDefinition,
  fieldDefinitions,
  fieldSegments,
  sideFromSegment
} from "./fieldStatus";

export interface FieldEntry {
  label: string;
  category: FieldDefinition["category"];
  detail: string;
}

export interface FieldState {
  weather: FieldEntry | null;
  terrain: FieldEntry | null;
  global: FieldEntry[];
  own: FieldEntry[];
  opponent: FieldEntry[];
  unknownSide: FieldEntry[];
  notes: string[];
}

export function emptyFieldState(): FieldState {
  return { weather: null, terrain: null, global: [], own: [], opponent: [], unknownSide: [], notes: [] };
}

// 「消えた」系の観測。設置物・壁・天候の解除として扱う。
const REMOVAL_PATTERN = /解除|消え|消滅|なくな|無くな|終わっ|終了|切れ|割れ|壊れ|剥がれ|はがれ|やんだ|止んだ|おさまっ/;

const MAX_NOTES = 4;

function matchedDefinitions(segment: string): FieldDefinition[] {
  return fieldDefinitions.filter((definition) => definition.patterns.some((pattern) => pattern.test(segment)));
}

// 「強い雨」は「雨」のパターンにも一致する。ラベルが最長の定義を優先する。
function mostSpecific(definitions: FieldDefinition[]): FieldDefinition {
  return definitions.reduce((left, right) => (right.label.length > left.label.length ? right : left));
}

function extractDetail(segment: string): string {
  return segment.match(/\d+\s*(?:ターン|T|層|回)/i)?.[0]?.replace(/\s+/g, "") ?? "";
}

function upsert(entries: FieldEntry[], entry: FieldEntry): FieldEntry[] {
  const existing = entries.find((current) => current.label === entry.label);
  if (!existing) return [...entries, entry];
  return entries.map((current) =>
    current.label === entry.label ? { ...current, detail: entry.detail || current.detail } : current
  );
}

function removeLabel(entries: FieldEntry[], label: string): FieldEntry[] {
  return entries.filter((entry) => entry.label !== label);
}

function entryFor(definition: FieldDefinition, segment: string): FieldEntry {
  return { label: definition.label, category: definition.category, detail: extractDetail(segment) };
}

export function applyFieldObservation(current: FieldState, observation: string): FieldState {
  let next: FieldState = {
    ...current,
    global: [...current.global],
    own: [...current.own],
    opponent: [...current.opponent],
    unknownSide: [...current.unknownSide],
    notes: [...current.notes]
  };
  for (const segment of fieldSegments(observation)) {
    const definitions = matchedDefinitions(segment);
    const removal = REMOVAL_PATTERN.test(segment);
    if (definitions.length === 0) {
      // 定義に無い観測は原文のまま notes に残す(消える情報をゼロにするため)。
      if (!removal && !next.notes.includes(segment)) {
        next.notes = [...next.notes, segment].slice(-MAX_NOTES);
      }
      continue;
    }
    const weatherDefinitions = definitions.filter((definition) => definition.category === "weather");
    const otherDefinitions = definitions.filter((definition) => definition.category !== "weather");
    const applied = [...(weatherDefinitions.length > 0 ? [mostSpecific(weatherDefinitions)] : []), ...otherDefinitions];
    for (const definition of applied) {
      if (definition.category === "weather") {
        // 天候は同時に1つだけ。新しい観測が常に置き換える。
        next.weather = removal ? null : entryFor(definition, segment);
        continue;
      }
      if (definition.category === "terrain") {
        next.terrain = removal ? null : entryFor(definition, segment);
        continue;
      }
      if (definition.scope === "global") {
        next.global = removal
          ? removeLabel(next.global, definition.label)
          : upsert(next.global, entryFor(definition, segment));
        continue;
      }
      const side = sideFromSegment(segment);
      if (removal) {
        // 側の明示がない解除報告は、どちら側に記録されていても取り除く。
        if (side === "own" || side === "both" || side === null) next.own = removeLabel(next.own, definition.label);
        if (side === "opponent" || side === "both" || side === null) next.opponent = removeLabel(next.opponent, definition.label);
        next.unknownSide = removeLabel(next.unknownSide, definition.label);
        continue;
      }
      const entry = entryFor(definition, segment);
      if (side === "both") {
        next.own = upsert(next.own, entry);
        next.opponent = upsert(next.opponent, entry);
        next.unknownSide = removeLabel(next.unknownSide, definition.label);
      } else if (side === "own" || side === "opponent") {
        next[side] = upsert(next[side], entry);
        // 側が判明したら「側不明」から昇格させる。
        next.unknownSide = removeLabel(next.unknownSide, definition.label);
      } else if (
        !next.own.some((current) => current.label === definition.label) &&
        !next.opponent.some((current) => current.label === definition.label)
      ) {
        next.unknownSide = upsert(next.unknownSide, entry);
      }
    }
  }
  return next;
}

function serializeEntry(entry: FieldEntry): string {
  return `${entry.label}${entry.detail}`;
}

export function serializeFieldState(state: FieldState): string {
  const parts: string[] = [];
  if (state.weather) parts.push(`全体: ${serializeEntry(state.weather)}`);
  if (state.terrain) parts.push(`全体: ${serializeEntry(state.terrain)}`);
  for (const entry of state.global) parts.push(`全体: ${serializeEntry(entry)}`);
  for (const entry of state.own) parts.push(`自分側: ${serializeEntry(entry)}`);
  for (const entry of state.opponent) parts.push(`相手側: ${serializeEntry(entry)}`);
  for (const entry of state.unknownSide) parts.push(`側不明: ${serializeEntry(entry)}`);
  for (const note of state.notes) parts.push(note);
  return parts.join(" / ");
}

export function parseFieldState(field: string): FieldState {
  return applyFieldObservation(emptyFieldState(), field);
}

// 既存のfield文字列に新しい観測をマージして、正規形の文字列で返す。
// applyFactsToState はこれを使う。全置換はしない。
export function mergeFieldText(currentField: string, observation: string): string {
  const merged = applyFieldObservation(parseFieldState(currentField), observation);
  return serializeFieldState(merged);
}

// workflow側の判定ヘルパー。battleWorkflow / turnEvaluation の独自正規表現を置き換える
// 単一の参照先。「側不明」の効果は保守的に「効いていない」扱いにする(従来挙動と同じ)。
export function sideHasFieldEffect(field: string, side: "own" | "opponent", label: string): boolean {
  const state = parseFieldState(field);
  return state[side].some((entry) => entry.label === label);
}

export function sideHasTailwind(field: string, side: "own" | "opponent"): boolean {
  return sideHasFieldEffect(field, side, "おいかぜ");
}

export function fieldWeatherLabel(field: string): string {
  return parseFieldState(field).weather?.label ?? "";
}

export function globalHasFieldEffect(field: string, label: string): boolean {
  return parseFieldState(field).global.some((entry) => entry.label === label);
}
