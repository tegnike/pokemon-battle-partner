import dotenv from "dotenv";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import { normalizeBattleState, type BattleState, type BattleStatus } from "../src/domain";
import {
  createBattleSession,
  listBattleSessions,
  patchBattleSession,
  readBattleSession,
  saveBattleState
} from "../src/battles/store";
import { runBattleAdviceWorkflow } from "../src/mastra/battleWorkflow";
import {
  appendConversationTurn,
  appendLongTermMemoryNotes,
  readMemoryContext,
  type LongTermMemoryNote
} from "../src/memory/store";

const appRoot = path.resolve(process.cwd());
dotenv.config({ path: path.join(appRoot, ".env") });
dotenv.config({ path: "/Users/user/WorkSpace/nikechan/.env", override: false });

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 8787);
const transcriptionModel = process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
const adviceModel = process.env.ADVICE_MODEL ?? "gpt-5.4-mini";
const adviceReasoningEffort = (process.env.ADVICE_REASONING_EFFORT ?? "none") as ReasoningEffort;
const llmRequestTimeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 20_000);
const teamDocPath =
  process.env.TEAM_DOC_PATH ?? "/Users/user/WorkSpace/nikechan/docs/pokemon-champions-ai-team.md";
const logDir = path.join(appRoot, "data", "battles");
const championsDataDir = path.join(appRoot, "data", "champions");

app.use(express.json({ limit: "2mb" }));

function readTeamDoc(): string {
  try {
    return fs.readFileSync(teamDocPath, "utf8");
  } catch (error) {
    return `構築文書を読めませんでした: ${String(error)}`;
  }
}

function readChampionsJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(championsDataDir, file), "utf8")) as T;
}

function normalizeLookupKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[・\s._'-]/g, "");
}

function resolvePokemonId(value: string): string {
  const key = normalizeLookupKey(value);
  const aliases = readChampionsJson<{ pokemon: Record<string, string[]> }>("ja-aliases.json");
  for (const [id, names] of Object.entries(aliases.pokemon)) {
    if (normalizeLookupKey(id) === key || names.some((name) => normalizeLookupKey(name) === key)) {
      return id;
    }
  }
  return key;
}

function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set. Create .env from .env.example.");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} request timed out after ${ms}ms`)), ms);
    })
  ]);
}

function isRetryableModelError(error: unknown): boolean {
  const text = String(error);
  return (
    text.includes('"code":503') ||
    text.includes('"code":429') ||
    text.includes("status: 429") ||
    text.includes("status: 500") ||
    text.includes("status: 503") ||
    text.includes("UNAVAILABLE") ||
    text.includes("timed out")
  );
}

async function transcribeWithRetry(client: OpenAI, file: Express.Multer.File): Promise<string> {
  let lastError: unknown;
  const extensionByMime: Record<string, string> = {
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg"
  };
  const fallbackExtension = extensionByMime[file.mimetype] ?? "webm";
  const filename =
    file.originalname && path.extname(file.originalname)
      ? file.originalname
      : `battle-note.${fallbackExtension}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const uploadable = await toFile(file.buffer, filename, {
        type: file.mimetype || "audio/webm"
      });
      const response = await withTimeout(
        client.audio.transcriptions.create({
          file: uploadable,
          model: transcriptionModel,
          language: "ja",
          prompt:
            "ポケモンチャンピオンズの対戦メモです。ポケモン名、技名、HP割合、状態異常、選出情報を優先して日本語で正確に文字起こししてください。"
        }),
        20_000,
        "OpenAI transcription"
      );
      return response.text;
    } catch (error) {
      lastError = error;
      if (!isRetryableModelError(error) || attempt === 1) break;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastError;
}

function appendBattleLog(payload: unknown): void {
  fs.mkdirSync(logDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(logDir, `${date}.jsonl`), `${JSON.stringify(payload)}\n`);
}

function compactActionLabel(action: string, kind?: string, memo = ""): string {
  const trimmed = action.trim();
  const combined = `${trimmed}\n${memo}`;
  if (!trimmed) return "状況確認";
  if (kind === "note" || trimmed === "note") {
    if (combined.includes("選出理由")) return "選出理由";
    if (combined.includes("理由")) return "理由説明";
    if (combined.includes("覚えて")) return "記憶";
    if (combined.includes("反省")) return "反省会";
    return "状況確認";
  }
  if (trimmed.length <= 18) return trimmed;
  if (combined.includes("選出理由")) return "選出理由";
  if (kind === "selection" || combined.includes("選出")) return "選出";
  if (combined.includes("理由")) return "理由説明";
  return "会話";
}

app.get("/api/team-doc", (_req, res) => {
  res.json({ path: teamDocPath, markdown: readTeamDoc() });
});

app.get("/api/battles", (_req, res) => {
  try {
    res.json({ battles: listBattleSessions(appRoot) });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/api/battles", (req, res) => {
  try {
    const { opponentName } = req.body as { opponentName?: string };
    res.json(createBattleSession(appRoot, opponentName ?? ""));
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/battles/:battleId", (req, res) => {
  try {
    const state = readBattleSession(appRoot, req.params.battleId);
    if (!state) {
      res.status(404).json({ error: `Battle not found: ${req.params.battleId}` });
      return;
    }
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.put("/api/battles/:battleId", (req, res) => {
  try {
    const { state } = req.body as { state?: BattleState };
    if (!state) {
      res.status(400).json({ error: "state is required" });
      return;
    }
    const normalized = normalizeBattleState({ ...state, battleId: req.params.battleId });
    res.json(saveBattleState(appRoot, normalized));
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.patch("/api/battles/:battleId", (req, res) => {
  try {
    const { opponentName, status, phase } = req.body as {
      opponentName?: string;
      status?: BattleStatus;
      phase?: BattleState["phase"];
    };
    const patched = patchBattleSession(appRoot, req.params.battleId, {
      ...(typeof opponentName === "string" ? { opponentName } : {}),
      ...(status ? { status } : {}),
      ...(phase ? { phase } : {})
    });
    if (!patched) {
      res.status(404).json({ error: `Battle not found: ${req.params.battleId}` });
      return;
    }
    res.json(patched);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/champions-data/metadata", (_req, res) => {
  try {
    res.json(readChampionsJson("metadata.json"));
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/champions-data/pokemon/:name", (req, res) => {
  try {
    const id = resolvePokemonId(req.params.name);
    const pokemon = readChampionsJson<Array<{ id: string; name: string }>>("pokemon.json");
    const found = pokemon.find((entry) => entry.id === id || normalizeLookupKey(entry.name) === id);
    if (!found) {
      res.status(404).json({ error: `Pokemon not found: ${req.params.name}` });
      return;
    }
    res.json(found);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "audio file is required" });
      return;
    }
    const client = getOpenAI();
    const text = await transcribeWithRetry(client, req.file);
    res.json({ text: text.trim(), model: transcriptionModel });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/api/advise", async (req, res) => {
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort(new Error("client aborted advice request"));
  });
  try {
    const { state, transcript, conversationIntent } = req.body as {
      state?: BattleState;
      transcript?: string;
      conversationIntent?: "battle" | "chat" | "memory";
    };
    if (!state || !transcript) {
      res.status(400).json({ error: "state and transcript are required" });
      return;
    }

    const normalizedState = normalizeBattleState(state);
    getOpenAI();
    const memoryContext = readMemoryContext(
      appRoot,
      [transcript, normalizedState.opponentName, normalizedState.status].filter(Boolean).join("\n"),
      normalizedState.battleId
    );
    const result = await runBattleAdviceWorkflow({
      championsDataDir,
      readTeamDoc,
      appendBattleLog,
      adviceModel,
      adviceReasoningEffort,
      requestTimeoutMs: llmRequestTimeoutMs,
      abortSignal: abortController.signal,
      appendMemoryNotes: (notes) => {
        const enriched: LongTermMemoryNote[] = notes.map((note) => ({
          ...note,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString()
        }));
        appendLongTermMemoryNotes(appRoot, enriched);
      }
    }, {
      state: normalizedState,
      transcript,
      memoryContext: memoryContext.text,
      conversationIntent: conversationIntent ?? "battle"
    });
    if (abortController.signal.aborted) return;
    const turn = normalizedState.turn + 1;
    const turnEntry = {
      turn,
      transcript,
      action: compactActionLabel(result.action.command, result.action.kind, result.memo),
      memo: result.memo,
      createdAt: new Date().toISOString()
    };
    const persistedState = saveBattleState(appRoot, {
      ...result.updatedState,
      battleId: normalizedState.battleId,
      opponentName: result.updatedState.opponentName || normalizedState.opponentName,
      status: normalizedState.status,
      createdAt: normalizedState.createdAt,
      turn,
      latestMemo: result.memo,
      history: [...result.updatedState.history.slice(-19), turnEntry]
    });
    const persistedResult = { ...result, updatedState: persistedState };
    appendConversationTurn(appRoot, normalizedState, transcript, persistedResult);
    if (abortController.signal.aborted) return;
    res.json(persistedResult);
  } catch (error) {
    if (abortController.signal.aborted) {
      console.info("[api/advise] aborted before response");
      return;
    }
    res.status(500).json({ error: String(error) });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Pokemon Battle Partner API listening on http://127.0.0.1:${port}`);
  console.log(`Team doc: ${teamDocPath}`);
});
