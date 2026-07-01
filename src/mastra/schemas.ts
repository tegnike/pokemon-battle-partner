import { z } from "zod";

export const knownValueSchema = z.object({
  value: z.string(),
  status: z.enum(["unknown", "suspected", "confirmed"])
});

export const pokemonStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  selected: z.boolean(),
  active: z.boolean(),
  hpPercent: z.number().nullable(),
  currentHp: z.number().nullable(),
  maxHp: z.number().nullable(),
  condition: z.string(),
  ability: knownValueSchema,
  item: knownValueSchema,
  moves: z.array(knownValueSchema),
  statChanges: z.string(),
  notes: z.string()
});

export const turnEntrySchema = z.object({
  turn: z.number(),
  transcript: z.string(),
  action: z.string(),
  memo: z.string(),
  createdAt: z.string()
});

export const battleStateSchema = z.object({
  battleId: z.string(),
  phase: z.enum(["selection", "battle"]),
  status: z.enum(["active", "review", "closed"]),
  opponentName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turn: z.number(),
  opponentTeam: z.array(pokemonStateSchema),
  ownTeam: z.array(pokemonStateSchema),
  activeOwn: z.string(),
  activeOpponent: z.string(),
  field: z.string(),
  latestMemo: z.string(),
  history: z.array(turnEntrySchema)
});

export const adviceActionSchema = z.object({
  kind: z.enum(["selection", "move", "switch", "note"]),
  command: z.string(),
  reason: z.string(),
  risk: z.string(),
  confidence: z.enum(["high", "medium", "low"])
});

export const adviceResultSchema = z.object({
  updatedState: battleStateSchema,
  action: adviceActionSchema,
  speech: z.string(),
  memo: z.string()
});

export const certaintySchema = z.enum(["suspected", "confirmed"]);

export const battleFactsSchema = z.object({
  phase: z.enum(["selection", "battle"]).optional(),
  opponentName: z.string().optional(),
  opponentMentionedPokemon: z.array(z.string()).default([]),
  opponentSelectedPokemon: z.array(z.string()).default([]),
  ownSelectedPokemon: z.array(z.string()).default([]),
  activeOwn: z.string().optional(),
  activeOpponent: z.string().optional(),
  hpUpdates: z
    .array(
      z.object({
        side: z.enum(["own", "opponent"]),
        pokemon: z.string(),
        hpPercent: z.number()
      })
    )
    .default([]),
  faintedPokemon: z
    .array(
      z.object({
        side: z.enum(["own", "opponent"]),
        pokemon: z.string()
      })
    )
    .default([]),
  statuses: z
    .array(
      z.object({
        side: z.enum(["own", "opponent"]),
        pokemon: z.string(),
        condition: z.string()
      })
    )
    .default([]),
  revealedMoves: z
    .array(
      z.object({
        pokemon: z.string(),
        move: z.string(),
        certainty: certaintySchema
      })
    )
    .default([]),
  revealedAbility: z
    .array(
      z.object({
        pokemon: z.string(),
        ability: z.string(),
        certainty: certaintySchema
      })
    )
    .default([]),
  revealedItem: z
    .array(
      z.object({
        pokemon: z.string(),
        item: z.string(),
        certainty: certaintySchema
      })
    )
    .default([]),
  damageCalcRequests: z
    .array(
      z.object({
        attacker: z.string().optional(),
        defender: z.string().optional(),
        move: z.string().optional()
      })
    )
    .default([]),
  notes: z.array(z.string()).default([])
});

export const workflowInputSchema = z.object({
  state: battleStateSchema,
  transcript: z.string(),
  memoryContext: z.string().default(""),
  conversationIntent: z.enum(["battle", "chat", "memory"]).default("battle")
});

export const longTermMemoryNoteSchema = z.object({
  scope: z.enum(["global", "preference", "team", "battle", "opponent"]),
  content: z.string(),
  confidence: z.enum(["confirmed", "inferred"]),
  tags: z.array(z.string()).default([])
});

export const workflowTraceSchema = z.object({
  facts: battleFactsSchema,
  resolvedNames: z.record(z.string(), z.string().nullable()),
  damageCalcs: z.array(z.unknown()),
  timings: z.record(z.string(), z.number()).optional(),
  localKnowledge: z.string().optional(),
  memoryContext: z.string().optional(),
  memoryNotes: z.array(longTermMemoryNoteSchema).optional(),
  conversationIntent: z.enum(["battle", "chat", "memory"]).optional(),
  candidates: z.array(adviceActionSchema).optional(),
  agentToolCalls: z
    .object({
      candidates: z.array(z.unknown()),
      decision: z.array(z.unknown())
    })
    .optional(),
  guard: z.object({
    valid: z.boolean(),
    repaired: z.boolean(),
    errors: z.array(z.string())
  })
});

export const workflowOutputSchema = adviceResultSchema.extend({
  model: z.string(),
  workflowTraceId: z.string(),
  workflowTrace: workflowTraceSchema
});

export type BattleFacts = z.infer<typeof battleFactsSchema>;
export type WorkflowTrace = z.infer<typeof workflowTraceSchema>;
export type WorkflowOutput = z.infer<typeof workflowOutputSchema>;
