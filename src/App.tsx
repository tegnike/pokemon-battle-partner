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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { type BattleStatusSummary, type FieldStatusItem, summarizeBattleStatus } from "./fieldStatus";

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

interface SpeechOverlayState {
  text: string;
  updatedAt: string | null;
  source: string;
}

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

function adviceActionLabel(advice: AdviceResult | null): string {
  if (!advice) return "状況確認";
  if (advice.action.kind === "selection") return "選出理由";
  return compactActionLabel(advice.action.command, `${advice.action.reason}\n${advice.memo}`);
}

function voiceDeliveryLabel(advice: AdviceResult | null): string {
  const delivery = advice?.voiceDelivery;
  if (!delivery) return "";
  if (delivery.ok) return "AITuberKitへ発話送信済み";
  if (delivery.skipped && !delivery.enabled) return "AITuberKit発話は未設定";
  if (delivery.skipped) return delivery.message;
  return "AITuberKit発話送信に失敗";
}

// 履歴チップの色分け（試作版と同じ配色）
function historyChipClass(label: string): string {
  if (label.includes("選出")) return "sel";
  if (label.includes("反省")) return "review";
  if (label.includes("会話") || label.includes("記憶")) return "chat";
  if (label.includes("状況")) return "note";
  return "battle";
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

// HPの表示テキスト（自分=実数, 相手=割合）
function hpText(pokemon: PokemonState, side: "own" | "opponent"): string {
  if (side === "own") {
    if (pokemon.maxHp) return `${pokemon.currentHp ?? pokemon.maxHp} / ${pokemon.maxHp}`;
    return "-";
  }
  return `${pokemon.hpPercent ?? 100}%`;
}

// 残HPを 0-100 の割合で返す（HPバー用）
function hpPercentValue(pokemon: PokemonState, side: "own" | "opponent"): number {
  if (side === "own") {
    if (!pokemon.maxHp) return 100;
    const value = Math.round(((pokemon.currentHp ?? pokemon.maxHp) / pokemon.maxHp) * 100);
    return Math.max(0, Math.min(100, value));
  }
  return Math.max(0, Math.min(100, pokemon.hpPercent ?? 100));
}

// 残量に応じてHPバーの色を返す
function hpBarColor(pct: number): string {
  if (pct > 50) return "#10b981";
  if (pct >= 25) return "#f0a929";
  return "#e0455e";
}

function roleText(pokemon: PokemonState, side: "own" | "opponent"): string {
  if (pokemon.selected) return pokemon.active ? "選出 / 対面中" : "選出";
  return side === "opponent" ? "控え候補" : "控え";
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
  const pct = hpPercentValue(pokemon, side);
  return (
    <article className={["pokemon", pokemon.selected ? "selected" : "", pokemon.active ? "active" : ""].filter(Boolean).join(" ")}>
      {pokemon.active && <span className="face-badge">対面中</span>}
      <div className="pokemon-top">
        <div className="pokemon-identity">
          <PokemonIcon name={pokemon.name} />
          <div>
            <h3>{pokemon.name || "未確認"}</h3>
            <p className="role">{roleText(pokemon, side)}</p>
          </div>
        </div>
      </div>
      <div className="hp-block">
        <div className="hp-row">
          <span>HP</span>
          <b>{hpText(pokemon, side)}</b>
        </div>
        <div className="hp-bar">
          <div className="hp-fill" style={{ width: `${pct}%`, background: hpBarColor(pct) }} />
        </div>
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
          <span className="muted">技 未確認</span>
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

function statusItemClass(item: FieldStatusItem): string {
  return `status-chip status-${item.category}`;
}

function StatusChip({ item }: { item: FieldStatusItem }) {
  return (
    <span className={statusItemClass(item)}>
      <b>{item.label}</b>
      {item.detail && <small>{item.detail}</small>}
    </span>
  );
}

function StatusGroup({
  title,
  items,
  tone
}: {
  title: string;
  items: FieldStatusItem[];
  tone: "global" | "own" | "opponent" | "unknown" | "pokemon";
}) {
  return (
    <div className={`status-group ${tone}`}>
      <div className="status-group-head">
        <span>{title}</span>
        <em>{items.length ? `${items.length}件` : "なし"}</em>
      </div>
      <div className="status-chip-row">
        {items.length > 0 ? (
          items.map((item, index) => <StatusChip key={`${item.label}-${item.detail}-${index}`} item={item} />)
        ) : (
          <span className="status-empty">なし</span>
        )}
      </div>
    </div>
  );
}

function BattleStatusBoard({ summary }: { summary: BattleStatusSummary }) {
  const hasAnyStatus =
    summary.rawField ||
    summary.global.length > 0 ||
    summary.own.length > 0 ||
    summary.opponent.length > 0 ||
    summary.unknown.length > 0 ||
    summary.pokemon.length > 0;

  return (
    <section className="status-board">
      <div className="section-title">
        <span className="kicker">FIELD STATUS</span>
        <h2>場の状態</h2>
        <span className="count">{hasAnyStatus ? "反映中" : "なし"}</span>
      </div>
      <div className="status-board-grid">
        <StatusGroup title="全体" items={summary.global} tone="global" />
        <StatusGroup title="自分側" items={summary.own} tone="own" />
        <StatusGroup title="相手側" items={summary.opponent} tone="opponent" />
        <StatusGroup title="側不明・その他" items={summary.unknown} tone="unknown" />
      </div>
      <StatusGroup title="ポケモン状態・能力変化" items={summary.pokemon} tone="pokemon" />
      {summary.rawField && (
        <div className="status-raw">
          <span>元メモ</span>
          <p>{summary.rawField}</p>
        </div>
      )}
    </section>
  );
}

function fitSingleLineText(box: HTMLDivElement, text: HTMLSpanElement): void {
  const availableWidth = Math.max(0, box.clientWidth - 32);
  const availableHeight = Math.max(0, box.clientHeight - 12);
  const minSize = 16;
  const maxSize = 72;
  let best = minSize;
  let low = minSize;
  let high = maxSize;

  for (let step = 0; step < 10; step += 1) {
    const next = Math.floor((low + high) / 2);
    text.style.fontSize = `${next}px`;
    if (text.scrollWidth <= availableWidth && text.scrollHeight <= availableHeight) {
      best = next;
      low = next + 1;
    } else {
      high = next - 1;
    }
  }
  text.style.fontSize = `${best}px`;
  const scaleX = text.scrollWidth > availableWidth && availableWidth > 0
    ? Math.max(0.4, availableWidth / text.scrollWidth)
    : 1;
  text.style.transform = scaleX < 1 ? `scaleX(${scaleX})` : "";
}

function ObsSpeechOverlay() {
  const [speech, setSpeech] = useState<SpeechOverlayState>({ text: "", updatedAt: null, source: "startup" });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSpeech() {
      try {
        const response = await fetch("/api/speech", { cache: "no-store" });
        if (!response.ok) return;
        const json = (await response.json()) as SpeechOverlayState;
        if (!cancelled) setSpeech(json);
      } catch {
        // OBS表示を止めないため、取得失敗時は前回表示を維持する。
      }
    }
    void loadSpeech();
    const interval = window.setInterval(loadSpeech, 700);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text) return;
    const fit = () => fitSingleLineText(box, text);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [speech.text]);

  return (
    <div className="obs-page">
      <div className="obs-speech-box" ref={boxRef}>
        <span className="obs-speech-text" ref={textRef}>
          {speech.text}
        </span>
      </div>
    </div>
  );
}

// 現在の対面を大きく表示するバンド（自分＝左 / 相手＝右）
function MatchupBand({ own, opponent }: { own: PokemonState | null; opponent: PokemonState | null }) {
  if (!own && !opponent) return null;
  const ownPct = own ? hpPercentValue(own, "own") : 0;
  const oppPct = opponent ? hpPercentValue(opponent, "opponent") : 0;
  return (
    <section className="matchup">
      <div className="matchup-side own">
        {own ? (
          <>
            <PokemonIcon name={own.name} />
            <div className="matchup-info">
              <div className="matchup-name">
                <span className="tag own">YOU</span>
                {own.name || "未確認"}
              </div>
              <div className="matchup-hp">
                <span>HP</span>
                <b>{hpText(own, "own")}</b>
              </div>
              <div className="hp-bar">
                <div className="hp-fill" style={{ width: `${ownPct}%`, background: hpBarColor(ownPct) }} />
              </div>
            </div>
          </>
        ) : (
          <div className="matchup-empty">自分の対面未確定</div>
        )}
      </div>
      <div className="matchup-vs">
        <span>VS</span>
        <em>対面中</em>
      </div>
      <div className="matchup-side opp">
        {opponent ? (
          <>
            <PokemonIcon name={opponent.name} />
            <div className="matchup-info">
              <div className="matchup-name">
                {opponent.name || "未確認"}
                <span className="tag opp">OPPONENT</span>
              </div>
              <div className="matchup-hp">
                <span>HP</span>
                <b>{hpText(opponent, "opponent")}</b>
              </div>
              <div className="hp-bar">
                <div className="hp-fill" style={{ width: `${oppPct}%`, background: hpBarColor(oppPct) }} />
              </div>
            </div>
          </>
        ) : (
          <div className="matchup-empty">相手の対面未確定</div>
        )}
      </div>
    </section>
  );
}

// 列ヘッダーの選出ストリップ（選出済みのポケモンを順に表示）
function SelectionStrip({
  team,
  side,
  history = []
}: {
  team: PokemonState[];
  side: "own" | "opponent";
  history?: BattleState["history"];
}) {
  const selected = team.filter((entry) => entry.selected);
  const ordered = side === "opponent" ? sortByFirstMention(selected, history) : selected;
  if (ordered.length === 0) {
    return <p className="sel-empty">まだ選出未確定です。</p>;
  }
  return (
    <div className="sel-strip">
      {ordered.map((entry, index) => (
        <div className="sel-chip" key={entry.id}>
          <span className="sel-order">{index + 1}</span>
          <PokemonIcon name={entry.name} />
          <div>
            <strong>{entry.name || "未確認"}</strong>
            <span className="sel-hp">{hpText(entry, side)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function BattlePartnerApp() {
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
    if (recording || busy || !transcript.trim()) return;
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
  const activeOwnMon = state.ownTeam.find((pokemon) => pokemon.active) ?? null;
  const activeOppMon = state.opponentTeam.find((pokemon) => pokemon.active) ?? null;
  const adviceBusy = busy === "判断中";
  const adviceLabel = adviceActionLabel(advice);
  const deliveryLabel = voiceDeliveryLabel(advice);
  const consultationDisabled = Boolean(busy) || recording || !transcript.trim();
  const statusSummary = summarizeBattleStatus(state);

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">N</div>
          <div>
            <h1>Pokémon Battle Partner</h1>
            <p className="subtitle">Pokemon Champions · OpenAI · AI ニケちゃん</p>
          </div>
        </div>
        <div className="top-controls">
          <label className="field-label">
            対戦
            <select value={state.battleId} onChange={(event) => void selectBattle(event.target.value)}>
              {battles.map((battle) => (
                <option key={battle.battleId} value={battle.battleId}>
                  {battle.opponentName || "相手未設定"} / T{battle.turn} / {battle.status}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            相手名
            <input
              value={opponentNameDraft}
              onBlur={() => void saveOpponentName()}
              onChange={(event) => setOpponentNameDraft(event.target.value)}
              placeholder="対戦相手名"
            />
          </label>
          <button className="icon-button" onClick={() => void createNewBattle()} title="新規対戦">
            <Plus size={18} />
          </button>
          <button className="icon-button" onClick={() => void loadBattleSessions()} title="再読み込み">
            <RotateCcw size={17} />
          </button>
        </div>
      </header>

      <section className="console">
        <section className="advice">
          <div className="advice-head">
            <div className="advice-tag">
              <span className="dot" />
              NIKE'S CALL <em>次の一手</em>
            </div>
            <span className={`confidence ${advice?.action.confidence ?? "low"}`}>
              {advice ? advice.action.confidence.toUpperCase() : "WAITING"}
            </span>
          </div>
          <div className="advice-command">
            {activeOwnMon && <PokemonIcon name={activeOwnMon.name} />}
            <div>
              <div className="advice-kicker">推奨アクション</div>
              <span
                className={`advice-action-chip ${historyChipClass(adviceLabel)}`}
                title={advice?.action.command}
              >
                {advice ? adviceLabel : "状況を入力してください"}
              </span>
            </div>
          </div>
          <p className="speech">{advice?.speech ?? "入力後、選出相談か対戦相談を選んでください。"}</p>
          {deliveryLabel && (
            <p className={`voice-delivery ${advice?.voiceDelivery?.ok ? "ok" : "warn"}`} title={advice?.voiceDelivery?.error}>
              {deliveryLabel}
            </p>
          )}
          {advice?.action.reason && (
            <div className="advice-reason">
              <span>理由</span>
              <p>{advice.action.reason}</p>
            </div>
          )}
          {advice?.action.risk && (
            <div className="advice-risk">
              <span>リスク</span>
              <p>{advice.action.risk}</p>
            </div>
          )}
        </section>

        <section className="command-band">
          <div className="panel-label">
            <span className="kicker">INPUT</span>
            <span className="title">状況入力</span>
          </div>
          <button
            className={recording ? "record stop" : "record"}
            onClick={recording ? stopRecording : startRecording}
            disabled={Boolean(busy)}
          >
            {recording ? <span className="rec-dot" /> : <Mic size={18} />}
            {recording ? "録音を停止" : "録音する"}
          </button>
          <textarea
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            placeholder="相手の6体、選出、現在対面、HP、技、状態異常、前ターン結果を話すか入力してください。"
          />
          <div className="action-grid">
            <button
              className="primary selection-submit"
              onClick={() => void requestAdvice("selection")}
              disabled={consultationDisabled}
              title={recording ? "録音中は相談できません" : undefined}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <Users size={18} />}
              選出相談
            </button>
            <button
              className="primary battle-submit"
              onClick={() => void requestAdvice("battle")}
              disabled={consultationDisabled}
              title={recording ? "録音中は相談できません" : undefined}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <Swords size={18} />}
              対戦相談
            </button>
            <button
              className="primary chat-submit"
              onClick={() => void requestAdvice("chat")}
              disabled={consultationDisabled}
              title={recording ? "録音中は相談できません" : undefined}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <MessageSquareText size={18} />}
              会話
            </button>
            <button
              className="primary review-submit"
              onClick={() => void requestAdvice("review")}
              disabled={consultationDisabled}
              title={recording ? "録音中は相談できません" : undefined}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <MessageSquareText size={18} />}
              反省会
            </button>
          </div>
          <button
            className="emergency-stop"
            onClick={stopAdviceRequest}
            disabled={!adviceBusy}
            title="相談を停止して結果を反映しない"
          >
            <Ban size={15} />
            緊急停止 <small>相談中のみ有効</small>
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      </section>

      <MatchupBand own={activeOwnMon} opponent={activeOppMon} />

      <BattleStatusBoard summary={statusSummary} />

      <section className="layout">
        <div className="column own">
          <div className="section-title">
            <span className="kicker">YOUR TEAM</span>
            <h2>自分</h2>
            <span className="count">{selectedOwn.length} / 6 選出</span>
          </div>
          <SelectionStrip team={state.ownTeam} side="own" />
          <div className="grid">
            {ownTeamForDisplay.map((pokemon) => (
              <PokemonPanel key={pokemon.id} pokemon={pokemon} side="own" />
            ))}
          </div>
        </div>

        <div className="column opp">
          <div className="section-title">
            <span className="kicker">OPPONENT</span>
            <h2>相手</h2>
            <span className="count">{selectedOpponent.length} / 6 選出</span>
          </div>
          <SelectionStrip team={state.opponentTeam} side="opponent" history={state.history} />
          <div className="grid">
            {opponentTeamForDisplay.map((pokemon) => (
              <PokemonPanel key={pokemon.id} pokemon={pokemon} side="opponent" />
            ))}
          </div>
        </div>
      </section>

      <section className="bottom">
        <div className="memo-panel">
          <div className="section-title">
            <span className="kicker">MEMO</span>
            <h2>メモ</h2>
          </div>
          <p>{state.latestMemo || "まだメモはありません。"}</p>
          {state.field && (
            <div className="field">
              <span className="kicker">FIELD</span>
              <span className="value">{state.field}</span>
            </div>
          )}
        </div>

        <div className="history">
          <div className="section-title">
            <span className="kicker">LOG</span>
            <h2>履歴</h2>
            <span className="count">{state.history.length}件</span>
          </div>
          {state.history.length === 0 ? (
            <p className="muted">ログなし</p>
          ) : (
            state.history
              .slice()
              .reverse()
              .map((entry) => {
                const label = compactActionLabel(entry.action, entry.memo);
                return (
                  <article key={`${entry.createdAt}-${entry.turn}`} className="history-row">
                    <span className="turn">T{entry.turn}</span>
                    <span className={`chip ${historyChipClass(label)}`} title={entry.action}>
                      {label}
                    </span>
                    <p>{entry.memo}</p>
                  </article>
                );
              })
          )}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  if (window.location.pathname === "/obs") {
    return <ObsSpeechOverlay />;
  }
  return <BattlePartnerApp />;
}
