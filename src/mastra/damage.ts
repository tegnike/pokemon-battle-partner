import { calculateChampionsStats, type NatureModifiers, type StatPoints } from "../champions/statCalc";
import type { LocalDataStore, LocalPokemon, LocalMove } from "./localData";

export interface DamageCalcRequest {
  attacker: string;
  defender: string;
  move: string;
  attackerStatPoints?: StatPoints;
  attackerNature?: NatureModifiers;
  defenderAssumptions?: Array<{
    label: string;
    statPoints?: StatPoints;
    nature?: NatureModifiers;
  }>;
}

export interface DamageCalcResult {
  attacker: string;
  defender: string;
  move: string;
  assumptions: Array<{
    label: string;
    defenderHp: number;
    defenderRelevantDefense: number;
    damageMin: number;
    damageMax: number;
    percentMin: number;
    percentMax: number;
    ohko: boolean;
  }>;
}

export const typeChart: Record<string, Record<string, number>> = {
  Normal: {
    Rock: 0.5,
    Ghost: 0,
    Steel: 0.5
  },
  Fire: {
    Fire: 0.5,
    Water: 0.5,
    Grass: 2,
    Ice: 2,
    Bug: 2,
    Rock: 0.5,
    Dragon: 0.5,
    Steel: 2
  },
  Water: {
    Fire: 2,
    Water: 0.5,
    Grass: 0.5,
    Ground: 2,
    Rock: 2,
    Dragon: 0.5
  },
  Electric: {
    Water: 2,
    Electric: 0.5,
    Grass: 0.5,
    Ground: 0,
    Flying: 2,
    Dragon: 0.5
  },
  Grass: {
    Fire: 0.5,
    Water: 2,
    Grass: 0.5,
    Poison: 0.5,
    Ground: 2,
    Flying: 0.5,
    Bug: 0.5,
    Rock: 2,
    Dragon: 0.5,
    Steel: 0.5
  },
  Ice: {
    Fire: 0.5,
    Water: 0.5,
    Grass: 2,
    Ice: 0.5,
    Ground: 2,
    Flying: 2,
    Dragon: 2,
    Steel: 0.5
  },
  Fighting: {
    Normal: 2,
    Ice: 2,
    Poison: 0.5,
    Flying: 0.5,
    Psychic: 0.5,
    Bug: 0.5,
    Rock: 2,
    Ghost: 0,
    Dark: 2,
    Steel: 2,
    Fairy: 0.5
  },
  Poison: {
    Grass: 2,
    Poison: 0.5,
    Ground: 0.5,
    Rock: 0.5,
    Ghost: 0.5,
    Steel: 0,
    Fairy: 2
  },
  Ground: {
    Fire: 2,
    Electric: 2,
    Grass: 0.5,
    Poison: 2,
    Flying: 0,
    Bug: 0.5,
    Rock: 2,
    Steel: 2
  },
  Flying: {
    Electric: 0.5,
    Grass: 2,
    Fighting: 2,
    Bug: 2,
    Rock: 0.5,
    Steel: 0.5
  },
  Psychic: {
    Fighting: 2,
    Poison: 2,
    Psychic: 0.5,
    Dark: 0,
    Steel: 0.5
  },
  Bug: {
    Fire: 0.5,
    Grass: 2,
    Fighting: 0.5,
    Poison: 0.5,
    Flying: 0.5,
    Psychic: 2,
    Ghost: 0.5,
    Dark: 2,
    Steel: 0.5,
    Fairy: 0.5
  },
  Rock: {
    Fire: 2,
    Ice: 2,
    Fighting: 0.5,
    Ground: 0.5,
    Flying: 2,
    Bug: 2,
    Steel: 0.5
  },
  Ghost: {
    Normal: 0,
    Psychic: 2,
    Ghost: 2,
    Dark: 0.5
  },
  Dragon: {
    Dragon: 2,
    Steel: 0.5,
    Fairy: 0
  },
  Dark: {
    Fighting: 0.5,
    Psychic: 2,
    Ghost: 2,
    Dark: 0.5,
    Fairy: 0.5
  },
  Steel: {
    Fire: 0.5,
    Water: 0.5,
    Electric: 0.5,
    Ice: 2,
    Rock: 2,
    Steel: 0.5,
    Fairy: 2
  },
  Fairy: {
    Fire: 0.5,
    Fighting: 2,
    Poison: 0.5,
    Dragon: 2,
    Dark: 2,
    Steel: 0.5
  }
};

export function typeEffectiveness(moveType: string, defenderTypes: string[]): number {
  return defenderTypes.reduce((multiplier, type) => multiplier * (typeChart[moveType]?.[type] ?? 1), 1);
}

function damageRange({
  power,
  attack,
  defense,
  stab,
  effectiveness
}: {
  power: number;
  attack: number;
  defense: number;
  stab: number;
  effectiveness: number;
}): number[] {
  const level = 50;
  const base = Math.floor(Math.floor(Math.floor(((Math.floor((2 * level) / 5) + 2) * power * attack) / defense) / 50) + 2);
  return Array.from({ length: 16 }, (_, index) => Math.floor((base * stab * effectiveness * (85 + index)) / 100));
}

function relevantStats(attacker: LocalPokemon, defender: LocalPokemon, move: LocalMove, request: DamageCalcRequest) {
  const attackerStats = calculateChampionsStats({
    baseStats: attacker.baseStats,
    statPoints: request.attackerStatPoints ?? { spa: 32, spe: 32, hp: 2 },
    nature: request.attackerNature ?? { plus: "spa", minus: "atk" }
  });
  const assumptions = request.defenderAssumptions?.length
    ? request.defenderAssumptions
    : [
        { label: "無振り/補正なし", statPoints: {}, nature: {} },
        { label: "H32/補正なし", statPoints: { hp: 32 }, nature: {} },
        { label: "H32+D32/補正なし", statPoints: { hp: 32, spd: 32 }, nature: {} }
      ];
  return { attackerStats, assumptions };
}

export function calculateLocalDamage(store: LocalDataStore, request: DamageCalcRequest): DamageCalcResult {
  const attacker = store.getPokemon(request.attacker);
  const defender = store.getPokemon(request.defender);
  const move = store.getMove(request.move);
  if (!attacker || !defender || !move) {
    throw new Error(`Cannot resolve damage calc input: ${request.attacker} / ${request.defender} / ${request.move}`);
  }
  if (move.category === "Status" || move.basePower <= 0) {
    throw new Error(`Move is not damaging: ${move.name}`);
  }

  const { attackerStats, assumptions } = relevantStats(attacker, defender, move, request);
  const attack = move.category === "Physical" ? attackerStats.atk : attackerStats.spa;
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const effectiveness = typeEffectiveness(move.type, defender.types);

  return {
    attacker: attacker.name,
    defender: defender.name,
    move: move.name,
    assumptions: assumptions.map((assumption) => {
      const defenderStats = calculateChampionsStats({
        baseStats: defender.baseStats,
        statPoints: assumption.statPoints,
        nature: assumption.nature
      });
      const defense = move.category === "Physical" ? defenderStats.def : defenderStats.spd;
      const range = damageRange({
        power: move.basePower,
        attack,
        defense,
        stab,
        effectiveness
      });
      const min = range[0];
      const max = range[range.length - 1];
      return {
        label: assumption.label,
        defenderHp: defenderStats.hp,
        defenderRelevantDefense: defense,
        damageMin: min,
        damageMax: max,
        percentMin: Number(((min / defenderStats.hp) * 100).toFixed(1)),
        percentMax: Number(((max / defenderStats.hp) * 100).toFixed(1)),
        ohko: min >= defenderStats.hp
      };
    })
  };
}
