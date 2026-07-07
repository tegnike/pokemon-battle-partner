// 両面ターン評価。
// これまでの候補生成は「自分の技のダメージ%」しか見ておらず、
// (1) 相手からの被弾、(2) 補助技(おにび・ステルスロック等)の価値 が判断材料に一切入らなかった。
// このモジュールは対戦中の1ターンを両方向から評価する材料を作る:
//   - estimateIncomingThreats: 相手の場のポケモンがこちらへ入れてくるダメージの概算
//   - utilityMoveCandidates:   場の自分ポケモンの変化技を、効果説明つきの候補として生成
// どちらも最終判断を固定しない「材料」であり、採否は最終判断AIに委ねる。
import type { BattleState, PokemonState } from "../domain";
import {
  calculateChampionsStats,
  type NatureModifiers,
  type StatPoints
} from "../champions/statCalc";
import { globalHasFieldEffect, sideHasFieldEffect } from "../fieldState";
import { typeEffectiveness } from "./damage";
import type { LocalDataStore, LocalMove, LocalPokemon } from "./localData";

export const natureByJaName: Record<string, NatureModifiers> = {
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

export function parseStatProfile(notes: string): { nature?: NatureModifiers; statPoints: StatPoints } {
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

export interface IncomingThreat {
  attacker: string;
  defender: string;
  move: string;
  assumed: boolean;
  effectiveness: number;
  percentMin: number;
  percentMax: number;
  speedNote: string;
  note: string;
}

// 候補と同じ形の構造 (battleWorkflow の candidateActionSchema と構造的に互換)。
export interface UtilityCandidate {
  kind: "move";
  command: string;
  reason: string;
  risk: string;
  confidence: "medium" | "low";
}

const MAJOR_STATUS_KEYWORDS = ["やけど", "まひ", "ねむり", "こおり", "どく", "もうどく", "ひんし"];

const conditionLabelByStatus: Record<string, string> = {
  brn: "やけど",
  par: "まひ",
  slp: "ねむり",
  frz: "こおり",
  psn: "どく",
  tox: "もうどく"
};

const hazardLabelByMoveId: Record<string, string> = {
  stealthrock: "ステルスロック",
  spikes: "まきびし",
  toxicspikes: "どくびし",
  stickyweb: "ねばねばネット"
};

const sideFieldLabelByMoveId: Record<string, { label: string; side: "own" }> = {
  reflect: { label: "リフレクター", side: "own" },
  lightscreen: { label: "ひかりのかべ", side: "own" },
  auroraveil: { label: "オーロラベール", side: "own" },
  tailwind: { label: "おいかぜ", side: "own" }
};

function activeOwnPokemon(state: BattleState): PokemonState | undefined {
  return state.ownTeam.find((pokemon) => pokemon.active) ??
    state.ownTeam.find((pokemon) => pokemon.name === state.activeOwn && pokemon.name !== "");
}

function activeOpponentPokemon(state: BattleState): PokemonState | undefined {
  return state.opponentTeam.find((pokemon) => pokemon.active) ??
    state.opponentTeam.find((pokemon) => pokemon.name === state.activeOpponent && pokemon.name !== "");
}

function hasMajorStatus(condition: string): boolean {
  return MAJOR_STATUS_KEYWORDS.some((keyword) => condition.includes(keyword));
}

function ownHasGroundImmunity(own: PokemonState, ownLocal: LocalPokemon | null): boolean {
  if (ownLocal?.types.includes("Flying")) return true;
  const ability = own.ability.value;
  return ability === "ふゆう" || ability === "Levitate";
}

function maxInvestedSpeed(pokemon: LocalPokemon): number {
  return calculateChampionsStats({
    baseStats: pokemon.baseStats,
    statPoints: { spe: 32 },
    nature: { plus: "spe", minus: "atk" }
  }).spe;
}

function damageRolls(power: number, attack: number, defense: number, stab: number, effectiveness: number): { min: number; max: number } {
  const base = Math.floor(Math.floor(Math.floor(((Math.floor((2 * 50) / 5) + 2) * power * attack) / defense) / 50) + 2);
  const min = Math.floor((base * stab * effectiveness * 85) / 100);
  const max = Math.floor(base * stab * effectiveness);
  return { min, max };
}

interface ThreatSource {
  label: string;
  type: string;
  category: "Physical" | "Special";
  power: number;
  assumed: boolean;
}

// 相手の攻撃手段。判明している攻撃技があればそれを使い、無ければタイプ一致90威力を仮定する。
function opponentThreatSources(store: LocalDataStore, opponent: PokemonState | undefined, opponentLocal: LocalPokemon): ThreatSource[] {
  const revealedMoves = (opponent?.moves ?? []).flatMap((known) => {
    const local = store.getMove(known.value);
    if (!local || local.category === "Status" || local.basePower <= 0) return [];
    return [{ known, local }];
  });
  if (revealedMoves.length > 0) {
    return revealedMoves.map((entry) => ({
      label: entry.known.value,
      type: entry.local.type,
      category: entry.local.category as "Physical" | "Special",
      power: entry.local.basePower,
      assumed: entry.known.status === "suspected"
    }));
  }
  return opponentLocal.types.map((type) => ({
    label: `タイプ一致${type}技(威力90想定)`,
    type,
    category: (opponentLocal.baseStats.atk >= opponentLocal.baseStats.spa ? "Physical" : "Special") as "Physical" | "Special",
    power: 90,
    assumed: true
  }));
}

function threatDamagePercent(
  source: ThreatSource,
  opponentLocal: LocalPokemon,
  defender: PokemonState,
  defenderLocal: LocalPokemon
): { effectiveness: number; percentMin: number; percentMax: number } {
  const groundImmune = source.type === "Ground" && ownHasGroundImmunity(defender, defenderLocal);
  const effectiveness = groundImmune ? 0 : typeEffectiveness(source.type, defenderLocal.types);
  const attackKey = source.category === "Physical" ? "atk" : "spa";
  const attackerStats = calculateChampionsStats({
    baseStats: opponentLocal.baseStats,
    statPoints: { [attackKey]: 32 } as StatPoints,
    nature: { plus: attackKey, minus: attackKey === "atk" ? "spa" : "atk" } as NatureModifiers
  });
  const attack = source.category === "Physical" ? attackerStats.atk : attackerStats.spa;
  const profile = parseStatProfile(defender.notes);
  const defenderStats = calculateChampionsStats({
    baseStats: defenderLocal.baseStats,
    statPoints: profile.statPoints,
    nature: profile.nature ?? {}
  });
  const defense = source.category === "Physical" ? defenderStats.def : defenderStats.spd;
  const stab = opponentLocal.types.includes(source.type) ? 1.5 : 1;
  const rolls = damageRolls(source.power, attack, defense, stab, effectiveness);
  const maxHp = defender.maxHp ?? defenderStats.hp;
  return {
    effectiveness,
    percentMin: maxHp ? Number(((rolls.min / maxHp) * 100).toFixed(1)) : 0,
    percentMax: maxHp ? Number(((rolls.max / maxHp) * 100).toFixed(1)) : 0
  };
}

// 行動順の注記。トリックルーム中は速い方ではなく遅い方が先に動く。
function speedOrderNote(state: BattleState, ownSpeed: number | null, opponentMaxSpeed: number): string {
  const trickRoom = globalHasFieldEffect(state.field, "トリックルーム");
  if (ownSpeed === null) {
    return trickRoom ? "トリックルーム中(遅い方が先に動く)。こちらの素早さ実数値は不明" : "こちらの素早さ実数値は不明";
  }
  if (trickRoom) {
    return ownSpeed <= opponentMaxSpeed
      ? `トリックルーム中のため遅い方が先に動く。こちらS${ownSpeed}対相手最速想定${opponentMaxSpeed}で、こちらが先手の可能性が高い`
      : `トリックルーム中のため遅い方が先に動く。こちらS${ownSpeed}対相手最速想定${opponentMaxSpeed}で、相手が先手の可能性が高い`;
  }
  return ownSpeed >= opponentMaxSpeed
    ? `最速想定でもこちらが先手(S${ownSpeed}対最速${opponentMaxSpeed})`
    : `最速想定では相手が先手(S${ownSpeed}対最速${opponentMaxSpeed})`;
}

// 相手の場のポケモンが、こちらの場のポケモンへ入れてくるダメージの概算。
// 相手のステ振りは不明なため「攻撃最大振り・補正あり」の最大想定で見積もる。
export function estimateIncomingThreats(store: LocalDataStore, state: BattleState): IncomingThreat[] {
  if (state.phase !== "battle" || state.status !== "active") return [];
  const own = activeOwnPokemon(state);
  const opponent = activeOpponentPokemon(state);
  const opponentName = opponent?.name || state.activeOpponent;
  if (!own || !own.name || !opponentName) return [];
  const ownLocal = store.getPokemon(own.name);
  const opponentLocal = store.getPokemon(opponentName);
  if (!ownLocal || !opponentLocal) return [];

  const ownProfile = parseStatProfile(own.notes);
  const ownStats = calculateChampionsStats({
    baseStats: ownLocal.baseStats,
    statPoints: ownProfile.statPoints,
    nature: ownProfile.nature ?? {}
  });
  const ownMaxHp = own.maxHp ?? ownStats.hp;
  const ownCurrentPercent = own.hpPercent ?? (own.currentHp !== null && ownMaxHp ? (own.currentHp / ownMaxHp) * 100 : 100);
  const ownSpeed = ownProfile.statPoints.spe !== undefined && ownProfile.nature ? ownStats.spe : null;
  const speedNote = speedOrderNote(state, ownSpeed, maxInvestedSpeed(opponentLocal));

  const threats: IncomingThreat[] = [];
  for (const source of opponentThreatSources(store, opponent, opponentLocal)) {
    const damage = threatDamagePercent(source, opponentLocal, own, ownLocal);
    const note =
      damage.effectiveness === 0
        ? "無効"
        : damage.percentMin >= ownCurrentPercent
          ? "現在HPでは確定で落ちる圏内"
          : damage.percentMax >= ownCurrentPercent
            ? "現在HPでは最大乱数で落ちる圏内"
            : "";
    threats.push({
      attacker: opponentName,
      defender: own.name,
      move: source.label,
      assumed: source.assumed,
      effectiveness: damage.effectiveness,
      percentMin: damage.percentMin,
      percentMax: damage.percentMax,
      speedNote,
      note
    });
  }
  return threats.sort((left, right) => right.percentMax - left.percentMax).slice(0, 4);
}

export interface SwitchInRisk {
  pokemon: string;
  worstMove: string;
  assumed: boolean;
  effectiveness: number;
  percentMin: number;
  percentMax: number;
}

// 交代先候補(選出済み・ひんしでない・場にいない)が、相手の攻撃手段を受け出しした場合の
// 最大被弾。交代判断が「データ無しの受け出し」にならないようにするための材料。
export function estimateSwitchInRisks(store: LocalDataStore, state: BattleState): SwitchInRisk[] {
  if (state.phase !== "battle" || state.status !== "active") return [];
  const active = activeOwnPokemon(state);
  const opponent = activeOpponentPokemon(state);
  const opponentName = opponent?.name || state.activeOpponent;
  if (!opponentName) return [];
  const opponentLocal = store.getPokemon(opponentName);
  if (!opponentLocal) return [];
  const sources = opponentThreatSources(store, opponent, opponentLocal);
  if (sources.length === 0) return [];
  const bench = state.ownTeam.filter(
    (pokemon) =>
      pokemon.selected &&
      pokemon.name !== active?.name &&
      pokemon.hpPercent !== 0 &&
      pokemon.condition !== "ひんし"
  );
  const risks: SwitchInRisk[] = [];
  for (const pokemon of bench) {
    const local = store.getPokemon(pokemon.name);
    if (!local) continue;
    let worst: SwitchInRisk | null = null;
    for (const source of sources) {
      const damage = threatDamagePercent(source, opponentLocal, pokemon, local);
      if (!worst || damage.percentMax > worst.percentMax) {
        worst = {
          pokemon: pokemon.name,
          worstMove: source.label,
          assumed: source.assumed,
          effectiveness: damage.effectiveness,
          percentMin: damage.percentMin,
          percentMax: damage.percentMax
        };
      }
    }
    if (worst) risks.push(worst);
  }
  return risks;
}

export interface ThreatReport {
  threats: IncomingThreat[];
  switchInRisks: SwitchInRisk[];
}

export function buildThreatReport(store: LocalDataStore, state: BattleState): ThreatReport {
  return {
    threats: estimateIncomingThreats(store, state),
    switchInRisks: estimateSwitchInRisks(store, state)
  };
}

export function summarizeThreatReport(report: ThreatReport | undefined | null): string {
  const threats = report?.threats ?? [];
  const switchInRisks = report?.switchInRisks ?? [];
  if (threats.length === 0) return "なし(相手の場のポケモンが未確定、または対戦中ではありません)";
  const lines = [`行動順: ${threats[0].speedNote}。相手は攻撃最大振り想定。`];
  lines.push(`場の${threats[0].defender}への被弾:`);
  for (const threat of threats) {
    const detail = [threat.note, threat.assumed ? "推定" : "判明技"].filter(Boolean).join("、");
    lines.push(`- ${threat.attacker}の${threat.move}: 約${threat.percentMin}-${threat.percentMax}%${detail ? `(${detail})` : ""}`);
  }
  if (switchInRisks.length > 0) {
    lines.push("交代先が受け出しした場合の最大被弾(交代読みではなく同じ技を受けた想定):");
    for (const risk of switchInRisks) {
      const text =
        risk.effectiveness === 0
          ? `${risk.worstMove}は無効`
          : `${risk.worstMove}で約${risk.percentMin}-${risk.percentMax}%`;
      lines.push(`- ${risk.pokemon}: ${text}${risk.assumed ? "(推定)" : ""}`);
    }
  }
  return lines.join("\n");
}

function describeGuaranteedUtility(move: LocalMove): string | null {
  const parts: string[] = [];
  const hazard = hazardLabelByMoveId[move.id];
  if (hazard) parts.push(`相手側の場に${hazard}を設置する`);
  const sideField = sideFieldLabelByMoveId[move.id];
  if (sideField) parts.push(`自分側の場に${sideField.label}を張る`);
  if (move.status) {
    const label = conditionLabelByStatus[move.status] ?? move.status;
    parts.push(`相手を${label}状態にする`);
  }
  if (move.boosts) {
    const boostText = Object.entries(move.boosts)
      .map(([stat, stage]) => `${stat}${stage > 0 ? `+${stage}` : stage}`)
      .join("/");
    parts.push(move.target === "self" ? `自分の能力を${boostText}する` : `相手の能力を${boostText}する`);
  }
  if (move.self?.boosts) {
    const boostText = Object.entries(move.self.boosts)
      .map(([stat, stage]) => `${stat}${stage > 0 ? `+${stage}` : stage}`)
      .join("/");
    parts.push(`自分の能力を${boostText}する`);
  }
  if (parts.length === 0) return null;
  return parts.join("。");
}

function utilityMoveSuppressed(
  move: LocalMove,
  state: BattleState,
  opponent: PokemonState | undefined,
  opponentLocal: LocalPokemon | null
): boolean {
  // 状態異常技: 既に主要状態異常を持つ相手、タイプ・特性で無効な相手には出さない。
  if (move.status) {
    if (opponent && hasMajorStatus(opponent.condition)) return true;
    if (move.status === "brn" && opponentLocal?.types.includes("Fire")) return true;
    if (move.status === "par" && (opponentLocal?.types.includes("Electric") || opponentLocal?.types.includes("Ground"))) return true;
    if ((move.status === "psn" || move.status === "tox") &&
      (opponentLocal?.types.includes("Poison") || opponentLocal?.types.includes("Steel"))) return true;
  }
  // 設置技: 既に同じ設置物が相手側にあるなら重ねない(ステロは1回で十分)。
  const hazard = hazardLabelByMoveId[move.id];
  if (hazard && sideHasFieldEffect(state.field, "opponent", hazard)) return true;
  // 自分側の壁・追い風: 既に張ってあるなら出さない。
  const sideField = sideFieldLabelByMoveId[move.id];
  if (sideField && sideHasFieldEffect(state.field, "own", sideField.label)) return true;
  return false;
}

function utilityRisk(move: LocalMove, opponent: PokemonState | undefined): string {
  const base = "攻撃しないターンになるため、その間の被弾リスクと相手の積み・交代を考慮する必要があります。";
  if (move.status === "brn") {
    return `${base}相手が特殊主体の場合は火力半減の恩恵が薄くなります。`;
  }
  return base;
}

function utilityReason(move: LocalMove, moveName: string, effectText: string, opponentLocal: LocalPokemon | null): string {
  const notes: string[] = [`補助技候補: ${moveName}は${effectText}。`];
  if (move.status === "brn" && opponentLocal && opponentLocal.baseStats.atk >= opponentLocal.baseStats.spa) {
    notes.push("相手は物理寄りの種族値のため、やけどで火力を半減できる価値が高めです。");
  }
  if (hazardLabelByMoveId[move.id]) {
    notes.push("相手の交代が多い展開ほど価値が上がります。");
  }
  return notes.join("");
}

// 場の自分ポケモンの変化技を、効果説明つきの候補として返す。
// ダメージ候補と同列に最終判断AIへ渡す材料であり、ここでは採否を決めない。
export function utilityMoveCandidates(store: LocalDataStore, state: BattleState): UtilityCandidate[] {
  if (state.phase !== "battle" || state.status !== "active") return [];
  const own = activeOwnPokemon(state);
  if (!own || !state.activeOpponent) return [];
  const opponent = activeOpponentPokemon(state);
  const opponentLocal = store.getPokemon(opponent?.name || state.activeOpponent);
  const candidates: UtilityCandidate[] = [];
  for (const move of own.moves) {
    if (!move.value) continue;
    const local = store.getMove(move.value);
    if (!local || local.category !== "Status") continue;
    const effectText = describeGuaranteedUtility(local);
    if (!effectText) continue;
    if (utilityMoveSuppressed(local, state, opponent, opponentLocal)) continue;
    candidates.push({
      kind: "move",
      command: move.value,
      reason: utilityReason(local, move.value, effectText, opponentLocal),
      risk: utilityRisk(local, opponent),
      confidence: "medium"
    });
  }
  // 状態異常を与える技 > 設置技 > その他 の順で価値が高いことが多い。
  return candidates
    .sort((left, right) => utilityPriority(store, right.command) - utilityPriority(store, left.command))
    .slice(0, 2);
}

function utilityPriority(store: LocalDataStore, moveName: string): number {
  const move = store.getMove(moveName);
  if (!move) return 0;
  if (move.status) return 3;
  if (hazardLabelByMoveId[move.id]) return 2;
  if (sideFieldLabelByMoveId[move.id]) return 2;
  return 1;
}
