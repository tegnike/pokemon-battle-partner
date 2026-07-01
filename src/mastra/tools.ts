import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { calculateLocalDamage } from "./damage";
import type { LocalDataStore } from "./localData";

export function createPokemonLookupTool(store: LocalDataStore) {
  return createTool({
    id: "pokemonLookup",
    description: "Resolve a Pokemon name or Japanese alias against the local Pokemon Champions data.",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({
      found: z.boolean(),
      id: z.string().nullable(),
      name: z.string().nullable(),
      types: z.array(z.string()),
      baseStats: z.record(z.string(), z.number()).nullable(),
      abilities: z.record(z.string(), z.string()).nullable(),
      isMega: z.boolean().nullable()
    }),
    execute: async ({ name }) => {
      const pokemon = store.getPokemon(name);
      return {
        found: Boolean(pokemon),
        id: pokemon?.id ?? null,
        name: pokemon?.name ?? null,
        types: pokemon?.types ?? [],
        baseStats: pokemon?.baseStats ?? null,
        abilities: pokemon?.abilities ?? null,
        isMega: pokemon?.isMega ?? null
      };
    }
  });
}

export function createMoveLookupTool(store: LocalDataStore) {
  return createTool({
    id: "moveLookup",
    description: "Resolve a move name or Japanese alias against the local Pokemon Champions data.",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({
      found: z.boolean(),
      id: z.string().nullable(),
      name: z.string().nullable(),
      type: z.string().nullable(),
      category: z.string().nullable(),
      basePower: z.number().nullable()
    }),
    execute: async ({ name }) => {
      const move = store.getMove(name);
      return {
        found: Boolean(move),
        id: move?.id ?? null,
        name: move?.name ?? null,
        type: move?.type ?? null,
        category: move?.category ?? null,
        basePower: move?.basePower ?? null
      };
    }
  });
}

export function createDamageCalcTool(store: LocalDataStore) {
  return createTool({
    id: "damageCalc",
    description: "Calculate a local Pokemon Champions damage range using fixed IV 31 and stat points.",
    inputSchema: z.object({
      attacker: z.string(),
      defender: z.string(),
      move: z.string()
    }),
    outputSchema: z.unknown(),
    execute: async (input) => calculateLocalDamage(store, input)
  });
}
