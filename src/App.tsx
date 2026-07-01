import {
  Ban,
  LoaderCircle,
  MessageSquareText,
  Mic,
  Plus,
  RotateCcw,
  Square,
  Swords,
  Users
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type AdviceResult,
  type BattlePhase,
  type BattleState,
  type BattleStatus,
  type KnowledgeStatus,
  type PokemonState,
  createInitialBattleState,
  normalizeBattleState
} from "./domain";

const STORAGE_KEY = "pokemon-battle-partner-state";
const ACTIVE_BATTLE_KEY = "pokemon-battle-partner-active-battle";
const SPRITE_BASE_URL = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

interface PokemonIconData {
  name: string;
  num: number;
}

const pokemonIconCache = new Map<string, PokemonIconData | null>();

interface BattleSummary {
  battleId: string;
  opponentName: string;
  status: BattleStatus;
  phase: BattlePhase;
  turn: number;
  createdAt: string;
  updatedAt: string;
  latestMemo: string;
}

type ConsultationMode = "selection" | "battle" | "chat" | "review";

function compactActionLabel(action: string, memo = ""): string {
  const trimmed = action.trim();
  const combined = `${trimmed}\n${memo}`;
  if (!trimmed) return "状況確認";
  if (trimmed === "note") return "状況確認";
  if (trimmed.length <= 18) return trimmed;
  if (combined.includes("選出理由")) return "選出理由";
  if (combined.includes("選出")) return "選出";
  if (combined.includes("理由")) return "理由説明";
  if (combined.includes("覚えて")) return "記憶";
  if (combined.includes("反省")) return "反省会";
  return "会話";
}

function loadInitialState(): BattleState {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return createInitialBattleState();
  try {
    return normalizeBattleState(JSON.parse(saved));
  } catch {
    return createInitialBattleState();
  }
}

function statusLabel(status: KnowledgeStatus): string {
  if (status === "confirmed") return "確定";
  if (status === "suspected") return "推定";
  return "未確認";
}

function statusClass(status: KnowledgeStatus): string {
  return `knowledge knowledge-${status}`;
}

function hpLabel(pokemon: PokemonState, side: "own" | "opponent"): string {
  if (side === "own") {
    if (pokemon.maxHp) return `HP ${pokemon.currentHp ?? pokemon.maxHp}/${pokemon.maxHp}`;
    return "HP -";
  }
  return `HP ${pokemon.hpPercent ?? 100}%`;
}

function iconFallbackLabel(name: string): string {
  const normalized = name.trim();
  if (!normalized) return "?";
  return Array.from(normalized).slice(0, 2).join("");
}

function PokemonIcon({ name }: { name: string }) {
  const [iconData, setIconData] = useState<PokemonIconData | null>(() => pokemonIconCache.get(name) ?? null);
  const [failed, setFailed] = useState(false);
  const trimmedName = name.trim();

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!trimmedName) {
      setIconData(null);
      return;
    }
    if (pokemonIconCache.has(trimmedName)) {
      setIconData(pokemonIconCache.get(trimmedName) ?? null);
      return;
    }
    fetch(`/api/champions-data/pokemon/${encodeURIComponent(trimmedName)}`)
      .then(async (response) => {
        if (!response.ok) return null;
        const json = (await response.json()) as Partial<PokemonIconData>;
        if (typeof json.num !== "number" || !json.name) return null;
        return { name: json.name, num: json.num };
      })
      .then((resolved) => {
        if (cancelled) return;
        pokemonIconCache.set(trimmedName, resolved);
        setIconData(resolved);
      })
      .catch(() => {
        if (cancelled) return;
        pokemonIconCache.set(trimmedName, null);
        setIconData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trimmedName]);

  if (!trimmedName || !iconData || failed) {
    return <span className="pokemon-icon fallback">{iconFallbackLabel(trimmedName)}</span>;
  }

  return (
    <img
      className="pokemon-icon"
      src={`${SPRITE_BASE_URL}/${iconData.num}.png`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function sortSelectedFirst(team: PokemonState[]): PokemonState[] {
  return [...team].sort((a, b) => Number(b.selected) - Number(a.selected));
}

function sortByFirstMention(selected: PokemonState[], history: BattleState["history"]): PokemonState[] {
  return [...selected].sort((a, b) => {
    const aIndex = history.findIndex((entry) => entry.transcript.includes(a.name));
    const bIndex = history.findIndex((entry) => entry.transcript.includes(b.name));
    const aScore = aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex;
    const bScore = bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex;
    return aScore - bScore;
  });
}

function PokemonPanel({ pokemon, side }: { pokemon: PokemonState; side: "own" | "opponent" }) {
  const moves = pokemon.moves.filter((move) => move.value.trim().length > 0);
  const roleLabel = pokemon.selected ? "選出" : "候補";
  return (
    <article className={["pokemon", pokemon.selected ? "selected" : "", pokemon.active ? "active" : ""].filter(Boolean).join(" ")}>
      <div className="pokemon-top">
        <div className="pokemon-identity">
          <PokemonIcon name={pokemon.name} />
          <div>
            <h3>{pokemon.name || "未確認"}</h3>
            <p>{side === "opponent" ? (pokemon.selected ? "選出" : "控え候補") : roleLabel}</p>
          </div>
        </div>
        <span className="hp">{hpLabel(pokemon, side)}</span>
      </div>
      <div className="facts">
        <span className={statusClass(pokemon.ability.status)}>
          特性 {pokemon.ability.value || statusLabel(pokemon.ability.status)}
        </span>
        <span className={statusClass(pokemon.item.status)}>
          持物 {pokemon.item.value || statusLabel(pokemon.item.status)}
        </span>
      </div>
      <div className="moves">
        {moves.length === 0 ? (
          <span className="muted">技未確認</span>
        ) : (
          moves.map((move, index) => (
            <span className={statusClass(move.status)} key={`${move.value}-${index}`}>
              {move.value}
            </span>
          ))
        )}
      </div>
      {(pokemon.condition || pokemon.statChanges || pokemon.notes) && (
        <p className="notes">
          {[pokemon.condition, pokemon.statChanges, pokemon.notes].filter(Boolean).join(" / ")}
        </p>
      )}
    </article>
  );
}

function SelectionSummary({
  title,
  pokemon,
  side,
  history = []
}: {
  title: string;
  pokemon: PokemonState[];
  side: "own" | "opponent";
  history?: BattleState["history"];
}) {
  const selected = pokemon.filter((entry) => entry.selected);
  const orderedSelected = side === "opponent" ? sortByFirstMention(selected, history) : selected;
  return (
    <div className="selection-summary-block">
      <div className="section-title compact">
        <h2>{title}</h2>
        <span>{selected.length}/3</span>
      </div>
      {selected.length === 0 ? (
        <p className="selection-empty">まだ選出未確定です。</p>
      ) : (
        <div className="selection-list">
          {orderedSelected.map((entry, index) => (
            <article className="selection-card" key={entry.id}>
              <span className="selection-order">{index + 1}</span>
              <PokemonIcon name={entry.name} />
              <div>
                <strong>{entry.name}</strong>
                <p>{hpLabel(entry, side)}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<BattleState>(() => loadInitialState());
  const [battles, setBattles] = useState<BattleSummary[]>([]);
  const [opponentNameDraft, setOpponentNameDraft] = useState(() => state.opponentName);
  const [transcript, setTranscript] = useState("");
  const [advice, setAdvice] = useState<AdviceResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const initializedRef = useRef(false);
  const creatingBattleRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const adviceAbortRef = useRef<AbortController | null>(null);
  const adviceSnapshotRef = useRef<BattleState | null>(null);
  const adviceRequestIdRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(ACTIVE_BATTLE_KEY, state.battleId);
    setOpponentNameDraft(state.opponentName);
  }, [state]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void loadBattleSessions();
  }, []);

  useEffect(() => {
    return () => {
      adviceAbortRef.current?.abort();
    };
  }, []);

  async function loadBattleSessions() {
    try {
      const response = await fetch("/api/battles");
      const json = (await response.json()) as { battles?: BattleSummary[]; error?: string };
      if (!response.ok) throw new Error(json.error ?? "Failed to load battles");
      const loaded = json.battles ?? [];
      setBattles(loaded);
      if (loaded.length === 0) {
        await createNewBattle(false);
        return;
      }
      const activeId = localStorage.getItem(ACTIVE_BATTLE_KEY);
      const target = loaded.find((battle) => battle.battleId === activeId) ?? loaded[0];
      await selectBattle(target.battleId);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function refreshBattleSessions() {
    const response = await fetch("/api/battles");
    const json = (await response.json()) as { battles?: BattleSummary[] };
    if (response.ok) setBattles(json.battles ?? []);
  }

  async function patchBattle(patch: Partial<Pick<BattleState, "opponentName" | "status" | "phase">>) {
    const response = await fetch(`/api/battles/${state.battleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const json = (await response.json()) as BattleState & { error?: string };
    if (!response.ok) throw new Error(json.error ?? "Failed to update battle");
    const normalized = normalizeBattleState(json);
    setState(normalized);
    await refreshBattleSessions();
  }

  async function createNewBattle(askName = true) {
    if (creatingBattleRef.current) return;
    creatingBattleRef.current = true;
    const opponentName = askName ? (window.prompt("対戦相手の名前", "") ?? "") : "";
    try {
      const response = await fetch("/api/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opponentName })
      });
      const json = (await response.json()) as BattleState & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "Failed to create battle");
      const next = normalizeBattleState(json);
      setState(next);
      setAdvice(null);
      setTranscript("");
      setError("");
      await refreshBattleSessions();
    } finally {
      creatingBattleRef.current = false;
    }
  }

  async function selectBattle(battleId: string) {
    const response = await fetch(`/api/battles/${battleId}`);
    const json = (await response.json()) as BattleState & { error?: string };
    if (!response.ok) throw new Error(json.error ?? "Failed to load battle");
    const next = normalizeBattleState(json);
    setState(next);
    setAdvice(null);
    setTranscript("");
    setError("");
  }

  async function saveOpponentName() {
    try {
      await patchBattle({ opponentName: opponentNameDraft.trim() });
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function startRecording() {
    setError("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      void transcribeAudio(new Blob(chunksRef.current, { type: "audio/webm" }));
    };
    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function transcribeAudio(blob: Blob) {
    try {
      setBusy("文字起こし中");
      const body = new FormData();
      body.append("audio", blob, "battle-note.webm");
      const response = await fetch("/api/transcribe", { method: "POST", body });
      const json = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) throw new Error(json.error ?? "Transcription failed");
      setTranscript(json.text ?? "");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy("");
    }
  }

  async function requestAdvice(mode: ConsultationMode) {
    if (!transcript.trim()) return;
    const requestId = adviceRequestIdRef.current + 1;
    adviceRequestIdRef.current = requestId;
    adviceAbortRef.current?.abort();
    const controller = new AbortController();
    adviceAbortRef.current = controller;
    adviceSnapshotRef.current = state;
    try {
      setError("");
      setBusy("判断中");
      const phase: BattlePhase = mode === "selection" ? "selection" : mode === "chat" ? state.phase : "battle";
      const status: BattleStatus = mode === "review" ? "review" : mode === "chat" ? state.status : "active";
      const conversationIntent = mode === "chat" ? "chat" : "battle";
      const requestState = normalizeBattleState({
        ...state,
        phase,
        status
      });
      setState(requestState);
      const response = await fetch("/api/advise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ state: requestState, transcript, conversationIntent })
      });
      const json = (await response.json()) as (AdviceResult & { error?: string });
      if (controller.signal.aborted || requestId !== adviceRequestIdRef.current) return;
      if (!response.ok) throw new Error(json.error ?? "Advice failed");
      setState(normalizeBattleState(json.updatedState));
      setAdvice(json);
      await refreshBattleSessions();
    } catch (caught) {
      if (controller.signal.aborted || requestId !== adviceRequestIdRef.current) return;
      setError(String(caught));
    } finally {
      if (requestId === adviceRequestIdRef.current) {
        setBusy("");
        adviceAbortRef.current = null;
        adviceSnapshotRef.current = null;
      }
    }
  }

  function stopAdviceRequest() {
    if (!adviceAbortRef.current) return;
    adviceRequestIdRef.current += 1;
    adviceAbortRef.current.abort();
    adviceAbortRef.current = null;
    if (adviceSnapshotRef.current) setState(adviceSnapshotRef.current);
    adviceSnapshotRef.current = null;
    setBusy("");
    setError("相談を停止しました。押し間違いの結果は反映しません。");
  }

  const selectedOpponent = state.opponentTeam.filter((pokemon) => pokemon.selected);
  const selectedOwn = state.ownTeam.filter((pokemon) => pokemon.selected);
  const ownTeamForDisplay = sortSelectedFirst(state.ownTeam);
  const opponentTeamForDisplay = sortSelectedFirst(state.opponentTeam);
  const adviceBusy = busy === "判断中";

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Pokemon Battle Partner</h1>
          <p>Pokemon Champions / OpenAI / AI Nikechan</p>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => void createNewBattle()} title="新規対戦">
            <Plus size={18} />
          </button>
        </div>
      </header>

      <section className="battle-switcher">
        <div className="battle-select">
          <label>
            対戦
            <select value={state.battleId} onChange={(event) => void selectBattle(event.target.value)}>
              {battles.map((battle) => (
                <option key={battle.battleId} value={battle.battleId}>
                  {battle.opponentName || "相手未設定"} / T{battle.turn} / {battle.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            相手名
            <input
              value={opponentNameDraft}
              onBlur={() => void saveOpponentName()}
              onChange={(event) => setOpponentNameDraft(event.target.value)}
              placeholder="対戦相手名"
            />
          </label>
        </div>
        <div className="status-actions">
          <button className="icon-button" onClick={() => void loadBattleSessions()} title="再読み込み">
            <RotateCcw size={18} />
          </button>
        </div>
      </section>

      <section className="command-band">
        <div className="recorder">
          <button
            className={recording ? "record stop" : "record"}
            onClick={recording ? stopRecording : startRecording}
            disabled={Boolean(busy)}
          >
            {recording ? <Square size={18} /> : <Mic size={18} />}
            {recording ? "停止" : "録音"}
          </button>
          <button
            className="primary selection-submit"
            onClick={() => void requestAdvice("selection")}
            disabled={Boolean(busy) || !transcript.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <Users size={18} />}
            選出相談
          </button>
          <button
            className="primary battle-submit"
            onClick={() => void requestAdvice("battle")}
            disabled={Boolean(busy) || !transcript.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <Swords size={18} />}
            対戦相談
          </button>
          <button
            className="primary chat-submit"
            onClick={() => void requestAdvice("chat")}
            disabled={Boolean(busy) || !transcript.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <MessageSquareText size={18} />}
            会話
          </button>
          <button
            className="primary review-submit"
            onClick={() => void requestAdvice("review")}
            disabled={Boolean(busy) || !transcript.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <MessageSquareText size={18} />}
            反省会
          </button>
          {adviceBusy && (
            <button className="emergency-stop" onClick={stopAdviceRequest} title="相談を停止して結果を反映しない">
              <Ban size={18} />
              緊急停止
            </button>
          )}
        </div>
        <textarea
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder="相手の6体、選出、現在対面、HP、技、状態異常、前ターン結果を話すか入力してください。"
        />
        {error && <p className="error">{error}</p>}
      </section>

      <section className="advice">
        <div>
          <span className={`confidence ${advice?.action.confidence ?? "low"}`}>
            {advice ? advice.action.confidence.toUpperCase() : "WAITING"}
          </span>
          <h2>{advice?.action.command ?? "状況を入力してください"}</h2>
        </div>
        <p className="speech">{advice?.speech ?? "入力後、選出相談か対戦相談を選んでください。"}</p>
        {advice?.action.reason && <p>{advice.action.reason}</p>}
        {advice?.action.risk && <p className="risk">{advice.action.risk}</p>}
      </section>

      <section className="selection-overview">
        <SelectionSummary title="自分の選出" pokemon={state.ownTeam} side="own" />
        <SelectionSummary title="相手の選出" pokemon={state.opponentTeam} side="opponent" history={state.history} />
      </section>

      <section className="layout">
        <div className="column">
          <div className="section-title">
            <h2>相手</h2>
            <span>{selectedOpponent.length}/3 選出</span>
          </div>
          <div className="grid">
            {opponentTeamForDisplay.map((pokemon) => (
              <PokemonPanel key={pokemon.id} pokemon={pokemon} side="opponent" />
            ))}
          </div>
        </div>

        <div className="column">
          <div className="section-title">
            <h2>自分</h2>
            <span>{selectedOwn.length}/3 選出</span>
          </div>
          <div className="grid">
            {ownTeamForDisplay.map((pokemon) => (
              <PokemonPanel key={pokemon.id} pokemon={pokemon} side="own" />
            ))}
          </div>
          <div className="memo">
            <h2>メモ</h2>
            <p>{state.latestMemo || "まだメモはありません。"}</p>
            {state.field && <p className="field">{state.field}</p>}
          </div>
        </div>
      </section>

      <section className="history">
        <div className="section-title">
          <h2>履歴</h2>
          <span>{state.history.length}件</span>
        </div>
        {state.history.length === 0 ? (
          <p className="muted">ログなし</p>
        ) : (
          state.history
            .slice()
            .reverse()
            .map((entry) => (
              <article key={`${entry.createdAt}-${entry.turn}`} className="history-row">
                <span>T{entry.turn}</span>
                <strong title={entry.action}>{compactActionLabel(entry.action, entry.memo)}</strong>
                <p>{entry.memo}</p>
              </article>
            ))
        )}
      </section>
    </main>
  );
}
