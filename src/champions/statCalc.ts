export type StatId = "hp" | "atk" | "def" | "spa" | "spd" | "spe";

export type BaseStats = Record<StatId, number>;

export type StatPoints = Partial<Record<StatId, number>>;

export interface NatureModifiers {
  plus?: Exclude<StatId, "hp"> | null;
  minus?: Exclude<StatId, "hp"> | null;
}

export interface ChampionsStatsInput {
  baseStats: BaseStats;
  statPoints?: StatPoints;
  nature?: NatureModifiers;
}

export interface ChampionsStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export const CHAMPIONS_LEVEL = 50;
export const CHAMPIONS_FIXED_IV = 31;
export const CHAMPIONS_STAT_POINT_MAX_PER_STAT = 32;
export const CHAMPIONS_STAT_POINT_MAX_TOTAL = 66;

function clampStatPoint(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(CHAMPIONS_STAT_POINT_MAX_PER_STAT, Math.floor(value ?? 0)));
}

export function validateStatPoints(statPoints: StatPoints = {}): string[] {
  const errors: string[] = [];
  const total = (Object.keys(statPoints) as StatId[]).reduce(
    (sum, stat) => sum + clampStatPoint(statPoints[stat]),
    0
  );
  if (total > CHAMPIONS_STAT_POINT_MAX_TOTAL) {
    errors.push(`stat point total must be <= ${CHAMPIONS_STAT_POINT_MAX_TOTAL}, got ${total}`);
  }
  for (const stat of Object.keys(statPoints) as StatId[]) {
    const value = statPoints[stat];
    if (value !== undefined && (value < 0 || value > CHAMPIONS_STAT_POINT_MAX_PER_STAT)) {
      errors.push(`${stat} must be between 0 and ${CHAMPIONS_STAT_POINT_MAX_PER_STAT}, got ${value}`);
    }
  }
  return errors;
}

function natureModifier(stat: Exclude<StatId, "hp">, nature?: NatureModifiers): number {
  if (nature?.plus === stat) return 1.1;
  if (nature?.minus === stat) return 0.9;
  return 1;
}

function baseTerm(base: number, statPoints: number): number {
  return Math.floor(((base * 2 + CHAMPIONS_FIXED_IV + statPoints * 2) * CHAMPIONS_LEVEL) / 100);
}

export function calculateChampionsStats(input: ChampionsStatsInput): ChampionsStats {
  const { baseStats, statPoints = {}, nature } = input;
  const hpPoints = clampStatPoint(statPoints.hp);
  const hp = baseStats.hp === 1 ? 1 : baseTerm(baseStats.hp, hpPoints) + CHAMPIONS_LEVEL + 10;

  const calcOther = (stat: Exclude<StatId, "hp">) =>
    Math.floor((baseTerm(baseStats[stat], clampStatPoint(statPoints[stat])) + 5) * natureModifier(stat, nature));

  return {
    hp,
    atk: calcOther("atk"),
    def: calcOther("def"),
    spa: calcOther("spa"),
    spd: calcOther("spd"),
    spe: calcOther("spe")
  };
}
