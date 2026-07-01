import type { BattleState, KnownValue, PokemonState } from "../domain";
import type { BattleFacts } from "./schemas";
import type { LocalDataStore, LocalPokemon } from "./localData";

export const MEGA_STONE_ITEM = "メガストーン";

export interface MegaEvolutionInfo {
  baseName: string;
  megaName: string;
}

function confirmedMegaStone(): KnownValue {
  return { value: MEGA_STONE_ITEM, status: "confirmed" };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseJapaneseMegaName(name: string): { baseName: string; variant: "" | "x" | "y" } | null {
  const trimmed = name.trim().normalize("NFKC");
  if (!trimmed.startsWith("メガ") || trimmed.length <= 2) return null;
  const body = trimmed.slice(2);
  const variant = body.match(/[XY]$/i)?.[0]?.toLowerCase() as "" | "x" | "y" | undefined;
  return {
    baseName: variant ? body.slice(0, -1) : body,
    variant: variant ?? ""
  };
}

function baseIdFromMegaId(id: string): string | null {
  if (id.endsWith("megax") || id.endsWith("megay")) return id.slice(0, -5);
  if (id.endsWith("mega")) return id.slice(0, -4);
  return null;
}

function displayPokemonName(pokemon: LocalPokemon, fallback: string): string {
  return pokemon.aliasesJa[0] ?? fallback;
}

function displayBaseNameForMega(store: LocalDataStore, mega: LocalPokemon, sourceName: string): string {
  const parsed = parseJapaneseMegaName(sourceName);
  const baseId = baseIdFromMegaId(mega.id);
  const base = baseId ? store.getPokemon(baseId) : null;
  return base ? displayPokemonName(base, parsed?.baseName ?? base.name) : parsed?.baseName ?? sourceName;
}

export function inferMegaEvolution(store: LocalDataStore, name: string): MegaEvolutionInfo | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const directPokemon = store.getPokemon(trimmed);
  if (directPokemon) {
    if (!directPokemon.isMega) return null;
    return {
      baseName: displayBaseNameForMega(store, directPokemon, trimmed),
      megaName: displayPokemonName(directPokemon, trimmed)
    };
  }

  const parsed = parseJapaneseMegaName(trimmed);
  if (!parsed) return null;

  const basePokemon = store.getPokemon(parsed.baseName);
  const megaPokemon = basePokemon ? store.getPokemon(`${basePokemon.id}mega${parsed.variant}`) : null;
  if (megaPokemon && !megaPokemon.isMega) return null;

  return {
    baseName: basePokemon ? displayPokemonName(basePokemon, parsed.baseName) : parsed.baseName,
    megaName: megaPokemon ? displayPokemonName(megaPokemon, trimmed) : trimmed
  };
}

export function collectMegaEvolutions(store: LocalDataStore, names: Array<string | undefined>): MegaEvolutionInfo[] {
  const byMegaName = new Map<string, MegaEvolutionInfo>();
  for (const name of names) {
    if (!name) continue;
    const evolution = inferMegaEvolution(store, name);
    if (evolution) byMegaName.set(evolution.megaName, evolution);
  }
  return [...byMegaName.values()];
}

function upgradeName(name: string | undefined, byBaseName: Map<string, MegaEvolutionInfo>): string | undefined {
  if (!name) return name;
  return byBaseName.get(name)?.megaName ?? name;
}

export function rewriteOpponentMegaFactReferences(facts: BattleFacts, evolutions: MegaEvolutionInfo[]): BattleFacts {
  if (evolutions.length === 0) return facts;
  const byBaseName = new Map(evolutions.map((evolution) => [evolution.baseName, evolution]));
  const upgradeOpponentName = (name: string) => upgradeName(name, byBaseName) ?? name;
  return {
    ...facts,
    opponentMentionedPokemon: unique(facts.opponentMentionedPokemon.map(upgradeOpponentName)),
    opponentSelectedPokemon: unique(facts.opponentSelectedPokemon.map(upgradeOpponentName)),
    activeOpponent: upgradeName(facts.activeOpponent, byBaseName),
    hpUpdates: facts.hpUpdates.map((update) => ({
      ...update,
      pokemon: update.side === "opponent" ? upgradeOpponentName(update.pokemon) : update.pokemon
    })),
    faintedPokemon: facts.faintedPokemon.map((fainted) => ({
      ...fainted,
      pokemon: fainted.side === "opponent" ? upgradeOpponentName(fainted.pokemon) : fainted.pokemon
    })),
    statuses: facts.statuses.map((status) => ({
      ...status,
      pokemon: status.side === "opponent" ? upgradeOpponentName(status.pokemon) : status.pokemon
    })),
    revealedMoves: facts.revealedMoves.map((move) => ({
      ...move,
      pokemon: upgradeOpponentName(move.pokemon)
    })),
    revealedAbility: facts.revealedAbility.map((ability) => ({
      ...ability,
      pokemon: upgradeOpponentName(ability.pokemon)
    })),
    revealedItem: facts.revealedItem.map((item) => ({
      ...item,
      pokemon: upgradeOpponentName(item.pokemon)
    })),
    damageCalcRequests: facts.damageCalcRequests.map((request) => ({
      ...request,
      defender: upgradeName(request.defender, byBaseName),
      attacker: upgradeName(request.attacker, byBaseName)
    }))
  };
}

function applyMegaStone(pokemon: PokemonState, megaName: string): PokemonState {
  return {
    ...pokemon,
    name: megaName,
    item: confirmedMegaStone()
  };
}

export function applyOpponentMegaEvolutions(state: BattleState, evolutions: MegaEvolutionInfo[]): BattleState {
  if (evolutions.length === 0) return state;
  const byBaseName = new Map(evolutions.map((evolution) => [evolution.baseName, evolution]));
  const byMegaName = new Map(evolutions.map((evolution) => [evolution.megaName, evolution]));
  return {
    ...state,
    activeOpponent: upgradeName(state.activeOpponent, byBaseName) ?? state.activeOpponent,
    opponentTeam: state.opponentTeam.map((pokemon) => {
      const evolution = byBaseName.get(pokemon.name) ?? byMegaName.get(pokemon.name);
      return evolution ? applyMegaStone(pokemon, evolution.megaName) : pokemon;
    })
  };
}
