// 助言品質評価ハーネス。
// tests/fixtures/battle-replays.json の「決断ターン」(selection/move/switch が出たターン)を対象に、
// 助言の質を (1)決定的メトリクス と (2)判定モデルのルーブリック採点 で数値化する。
//
// 既存の統合テスト(battle-replay.integration.mjs)が「壊れていないこと」の下限検査であるのに対し、
// このハーネスは「助言が良くなったか/悪くなったか」をブランチ間で比較するための測定器。
//
// 使い方:
//   npm run eval:advice -- --mode logged            # 過去に出荷された助言を採点(ワークフローは実行しない)
//   npm run eval:advice -- --mode live              # 現在のコードでターンを再生して採点
//   npm run eval:advice -- --mode live --limit 16   # 決断ターンから均等サンプリング
//   npm run eval:advice -- --mode logged --all      # 全決断ターン
//   npm run eval:advice -- --dry-run                # API を呼ばず決定的メトリクスのみ
//   npm run eval:advice -- --compare reports/eval/a.json reports/eval/b.json
//
// 設計メモ (docs/advice-eval.md に詳細):
// - 追認バイアス対策: 判定モデルは対象の助言を見る前に「自分ならどう指すか」を先に決め、
//   そのうえで対象を採点する。マスターやログの実選択は判定モデルに見せない。
// - ブランチ比較の公平性: 判定モデルへ渡す盤面コンテキストは候補生成パイプライン
//   (battleWorkflow.ts) を通さず、このスクリプト内の安定した実装だけで作る。
//   評価対象のコードが判定材料を書き換えて採点を汚染しないようにするため。
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import OpenAI from "openai";
import { normalizeBattleState, type BattleState, type PokemonState } from "../src/domain.ts";
import { runBattleAdviceWorkflow } from "../src/mastra/battleWorkflow.ts";
import { createLocalDataStore, type LocalDataStore } from "../src/mastra/localData.ts";
import { typeEffectiveness } from "../src/mastra/damage.ts";
import { calculateChampionsStats } from "../src/champions/statCalc.ts";

const appRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(appRoot, "tests", "fixtures", "battle-replays.json");
const battleLogsDir = path.join(appRoot, "data", "battles");
const reportsDir = path.join(appRoot, "reports", "eval");
const teamDocPath = process.env.TEAM_DOC_PATH ?? "/Users/user/WorkSpace/nikechan/docs/pokemon-champions-ai-team.md";

const DECISION_KINDS = new Set(["selection", "move", "switch"]);
const JUDGE_LENSES = [
  "火力効率と行動順(先手後手・ダメージレース)を最重視する審査員",
  "リスク管理(被弾・温存・交代判断・持ち物ケア)を最重視する審査員",
  "盤面状態・公開情報(判明済みの技/特性/持ち物/HP)との整合性を最重視する審査員"
];

interface CliOptions {
  mode: "logged" | "live";
  limit: number | null;
  all: boolean;
  battleFilter: string | null;
  panel: number;
  dryRun: boolean;
  label: string | null;
  compare: [string, string] | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "logged",
    limit: 16,
    all: false,
    battleFilter: null,
    panel: 1,
    dryRun: false,
    label: null,
    compare: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") options.mode = argv[++index] === "live" ? "live" : "logged";
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--all") options.all = true;
    else if (arg === "--battle") options.battleFilter = argv[++index];
    else if (arg === "--panel") options.panel = Math.max(1, Math.min(JUDGE_LENSES.length, Number(argv[++index])));
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--label") options.label = argv[++index];
    else if (arg === "--compare") options.compare = [argv[++index], argv[++index]];
  }
  return options;
}

interface FixtureTurn {
  turnIndex: number;
  transcript: string;
  preState: unknown;
  logged: { actionKind: string; actionCommand: string; phase: string };
}

interface EvalTarget {
  battleId: string;
  opponentName: string;
  turnIndex: number;
  transcript: string;
  preState: BattleState;
  logged: FixtureTurn["logged"];
}

interface AdviceUnderTest {
  kind: string;
  command: string;
  reason: string;
  risk: string;
  speech: string;
}

interface JudgeScore {
  lens: string;
  ownPick: string;
  tactics: number;
  safety: number;
  consistency: number;
  verdict: "better" | "equal" | "worse";
  critique: string;
}

interface TurnResult {
  label: string;
  battleId: string;
  turnIndex: number;
  transcript: string;
  advice: AdviceUnderTest;
  deterministic: {
    invariantViolations: string[];
    noteInActiveBattle: boolean;
    damageGap: { command: string; percentMax: number; bestCommand: string; bestPercentMax: number } | null;
  };
  judge: JudgeScore[] | null;
  judgeMean: { tactics: number; safety: number; consistency: number; overall: number } | null;
  error?: string;
  elapsedMs: number;
}

function loadTargets(options: CliOptions): EvalTarget[] {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    battles: Array<{ battleId: string; opponentName: string; turns: FixtureTurn[] }>;
  };
  const targets: EvalTarget[] = [];
  for (const battle of fixture.battles) {
    if (options.battleFilter && !battle.battleId.startsWith(options.battleFilter)) continue;
    for (const turn of battle.turns) {
      if (!DECISION_KINDS.has(turn.logged.actionKind)) continue;
      targets.push({
        battleId: battle.battleId,
        opponentName: battle.opponentName,
        turnIndex: turn.turnIndex,
        transcript: turn.transcript,
        preState: normalizeBattleState(turn.preState),
        logged: turn.logged
      });
    }
  }
  if (options.all || options.limit === null || targets.length <= options.limit) return targets;
  // 乱数を使わず均等ストライドで抽出する。同じ引数なら常に同じターン集合になり、
  // ブランチ間比較が同一母集団で行われることを保証する。
  const stride = targets.length / options.limit;
  const sampled: EvalTarget[] = [];
  for (let index = 0; index < options.limit; index += 1) {
    sampled.push(targets[Math.floor(index * stride)]);
  }
  return sampled;
}

// data/battles/*.jsonl が手元にあれば、loggedモードの助言に reason/risk/speech を補完する。
function loadLoggedDetails(): Map<string, { reason: string; risk: string; speech: string }> {
  const details = new Map<string, { reason: string; risk: string; speech: string }>();
  if (!fs.existsSync(battleLogsDir)) return details;
  for (const file of fs.readdirSync(battleLogsDir).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(battleLogsDir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as {
          battleId?: string;
          transcript?: string;
          result?: { action?: { reason?: string; risk?: string }; speech?: string };
        };
        if (!record.battleId || !record.transcript || !record.result?.action) continue;
        details.set(`${record.battleId}\n${record.transcript}`, {
          reason: record.result.action.reason ?? "",
          risk: record.result.action.risk ?? "",
          speech: record.result.speech ?? ""
        });
      } catch {
        // 壊れた行は無視する
      }
    }
  }
  return details;
}

// ---- 決定的メトリクス --------------------------------------------------------

function ownMoveNames(state: BattleState): Set<string> {
  const names = new Set<string>();
  for (const pokemon of state.ownTeam) {
    for (const move of pokemon.moves) {
      if (move.value) names.add(move.value);
    }
  }
  return names;
}

// battle-replay.integration.mjs の assertInvariants と同じ規則を、落とさず数える形に移植したもの。
function collectInvariantViolations(advice: AdviceUnderTest, preState: BattleState): string[] {
  const violations: string[] = [];
  if (!advice.command?.trim()) violations.push("action.command is empty");
  if (advice.speech && /\d(?:\.\d+)?\s*%/.test(advice.speech)) violations.push("raw percentage leaked into speech");
  if (preState.phase === "battle" && preState.status === "active") {
    if (advice.kind === "selection") violations.push("selection action returned mid-battle");
    if (advice.kind === "switch") {
      const target = preState.ownTeam.find((pokemon) => advice.command.includes(pokemon.name));
      if (!target) violations.push(`switch target is not an own Pokemon: ${advice.command}`);
      else {
        if (!target.selected) violations.push(`switch target not selected: ${target.name}`);
        if (target.hpPercent === 0 || target.condition === "ひんし") violations.push(`switch target fainted: ${target.name}`);
      }
    }
    if (advice.kind === "move" && !ownMoveNames(preState).has(advice.command)) {
      violations.push(`move is not on our team: ${advice.command}`);
    }
  }
  return violations;
}

// ---- 判定モデル用の盤面コンテキスト (評価スクリプト専用の安定実装) ----------------

function statProfileFromNotes(notes: string): { statPoints: Record<string, number>; nature: { plus?: string; minus?: string } } {
  const natureByJaName: Record<string, { plus: string; minus: string }> = {
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
  const keyByLabel: Record<string, string> = { H: "hp", A: "atk", B: "def", C: "spa", D: "spd", S: "spe" };
  const statPoints: Record<string, number> = {};
  for (const match of notes.matchAll(/\b([HABCDS])(\d{1,2})\b/g)) {
    statPoints[keyByLabel[match[1]]] = Number(match[2]);
  }
  for (const [name, nature] of Object.entries(natureByJaName)) {
    if (notes.includes(name)) return { statPoints, nature };
  }
  return { statPoints, nature: {} };
}

function describeSideMoves(store: LocalDataStore, attacker: PokemonState, defenderName: string): string[] {
  const defender = store.getPokemon(defenderName);
  const lines: string[] = [];
  for (const move of attacker.moves) {
    if (!move.value) continue;
    const local = store.getMove(move.value);
    if (!local) continue;
    const effectiveness = defender && local.category !== "Status"
      ? `相性x${typeEffectiveness(local.type, defender.types)}`
      : local.category === "Status" ? "変化技" : "相性不明";
    lines.push(
      `  - ${move.value} (${local.type}/${local.category}/威力${local.basePower}/優先度${local.priority}) ${effectiveness}${move.status === "suspected" ? " ※推定" : ""}`
    );
  }
  return lines;
}

function describePokemonLine(store: LocalDataStore, pokemon: PokemonState, side: "own" | "opponent"): string {
  const local = store.getPokemon(pokemon.name);
  const types = local ? local.types.join("/") : "タイプ不明";
  const hp = side === "own" && pokemon.maxHp
    ? `HP ${pokemon.currentHp ?? pokemon.maxHp}/${pokemon.maxHp}`
    : `HP ${pokemon.hpPercent ?? 100}%`;
  let speedText = "";
  if (local) {
    if (side === "own") {
      const profile = statProfileFromNotes(pokemon.notes);
      if (profile.statPoints.spe !== undefined && profile.nature.plus) {
        const stats = calculateChampionsStats({
          baseStats: local.baseStats,
          statPoints: profile.statPoints as never,
          nature: profile.nature as never
        });
        speedText = ` 実S${stats.spe}`;
      }
    } else {
      const maxSpeed = calculateChampionsStats({
        baseStats: local.baseStats,
        statPoints: { spe: 32 } as never,
        nature: { plus: "spe", minus: "atk" } as never
      }).spe;
      speedText = ` 最速想定S${maxSpeed}`;
    }
  }
  const moves = pokemon.moves.map((move) => `${move.value}${move.status === "suspected" ? "?" : ""}`).filter(Boolean);
  const extras = [
    pokemon.condition && `状態:${pokemon.condition}`,
    pokemon.statChanges && `能力変化:${pokemon.statChanges}`,
    pokemon.ability.value && `特性:${pokemon.ability.value}${pokemon.ability.status === "suspected" ? "?" : ""}`,
    pokemon.item.value && `持ち物:${pokemon.item.value}${pokemon.item.status === "suspected" ? "?" : ""}`,
    moves.length > 0 && `技:${moves.join("/")}`
  ].filter(Boolean).join(" ");
  return `- ${pokemon.name || "未確認"} (${types}) ${hp}${speedText}${pokemon.selected ? " [選出]" : ""}${pokemon.active ? " [場]" : ""} ${extras}`.trimEnd();
}

function buildJudgeBoardContext(store: LocalDataStore, state: BattleState): string {
  const lines: string[] = [];
  lines.push(`フェーズ: ${state.phase} / ステータス: ${state.status} / 場の状況: ${state.field || "なし"}`);
  lines.push(`現在対面: 自分=${state.activeOwn || "不明"} vs 相手=${state.activeOpponent || "不明"}`);
  lines.push("", "自分チーム:");
  for (const pokemon of state.ownTeam) {
    lines.push(describePokemonLine(store, pokemon, "own"));
  }
  lines.push("", "相手チーム(判明分):");
  for (const pokemon of state.opponentTeam.filter((entry) => entry.name)) {
    lines.push(describePokemonLine(store, pokemon, "opponent"));
    const knownMoves = describeSideMoves(store, pokemon, state.activeOwn);
    if (knownMoves.length > 0) lines.push(...knownMoves.map((line) => `  (判明技)${line.trim()}`));
  }
  const activeOwn = state.ownTeam.find((pokemon) => pokemon.name === state.activeOwn) ?? state.ownTeam.find((pokemon) => pokemon.active);
  if (state.phase === "battle" && activeOwn && state.activeOpponent) {
    lines.push("", `場の自分ポケモン(${activeOwn.name})の技と相手(${state.activeOpponent})への相性:`);
    lines.push(...describeSideMoves(store, activeOwn, state.activeOpponent));
  }
  if (state.history.length > 0) {
    lines.push("", "直近の流れ:");
    for (const entry of state.history.slice(-4)) {
      lines.push(`- ${entry.transcript.slice(0, 80)} => ${entry.action}`);
    }
  }
  return lines.join("\n");
}

// ---- 判定モデル --------------------------------------------------------------

function buildJudgePrompt(target: EvalTarget, advice: AdviceUnderTest, boardContext: string, lens: string): string {
  return `あなたはPokemon Champions(レベル50・シングル・3体選出)の対戦判断を審査する専門家です。
今回のあなたは「${lens}」として採点してください。

まず盤面とマスターの発話だけを読み、あなた自身ならどの一手(選出フェーズなら3体)を選ぶかを先に決めてください。
そのあとで、審査対象のAI助言を読み、以下のルーブリックで採点してください。
あなた自身の選択と違うだけでは減点しないこと。盤面情報から正当化できるかどうかだけで判断すること。

厳守事項:
- 自分側のポケモンが使える技は、盤面に「技:」として列挙されたものだけ。列挙されていない技を前提・提案してはいけない。
- 相手側の技・特性・持ち物は、盤面に書かれたもの(「?」付きは推定)だけを確定情報として扱い、それ以外は可能性として扱う。
- 一般的なポケモン対戦知識よりも、盤面に明記された数値・相性・状態を優先する。

ルーブリック(各1-5点):
- tactics: 戦術妥当性。ダメージ効率、行動順、勝ち筋への貢献。
- safety: リスク管理。被弾リスク、温存価値、持ち物(タスキ等)や交代の考慮。
- consistency: 整合性。判明済みの技・特性・持ち物・HP・タイプ相性と矛盾しないか。

verdict はあなた自身の選択と比べた相対評価: better(助言の方が良い) / equal(同等) / worse(助言の方が悪い)。

## 盤面
${boardContext}

## マスターの発話
${target.transcript}

## 審査対象のAI助言
- 種別: ${advice.kind}
- 指示: ${advice.command}
- 理由: ${advice.reason || "(記録なし)"}
- リスク説明: ${advice.risk || "(記録なし)"}
- セリフ: ${advice.speech || "(記録なし)"}

## 返すJSON形式
{
  "ownPick": "あなた自身が選んだ一手(またはあなたの選出3体)と一行理由",
  "tactics": 1-5,
  "safety": 1-5,
  "consistency": 1-5,
  "verdict": "better" | "equal" | "worse",
  "critique": "採点理由を2文以内で"
}`;
}

function clampScore(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 3;
  return Math.max(1, Math.min(5, Math.round(num)));
}

async function judgeAdvice(
  client: OpenAI,
  judgeModel: string,
  judgeEffort: string,
  target: EvalTarget,
  advice: AdviceUnderTest,
  boardContext: string,
  panel: number
): Promise<JudgeScore[]> {
  const scores: JudgeScore[] = [];
  for (const lens of JUDGE_LENSES.slice(0, panel)) {
    const prompt = buildJudgePrompt(target, advice, boardContext, lens);
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      try {
        const completion = await client.chat.completions.create({
          model: judgeModel,
          reasoning_effort: judgeEffort as never,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        });
        const text = completion.choices[0]?.message?.content ?? "";
        parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/, "")) as Record<string, unknown>;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    if (!parsed) continue;
    scores.push({
      lens,
      ownPick: String(parsed.ownPick ?? ""),
      tactics: clampScore(parsed.tactics),
      safety: clampScore(parsed.safety),
      consistency: clampScore(parsed.consistency),
      verdict: parsed.verdict === "better" || parsed.verdict === "worse" ? parsed.verdict : "equal",
      critique: String(parsed.critique ?? "")
    });
  }
  return scores;
}

// ---- 助言の取得 (logged / live) ----------------------------------------------

function buildWorkflowDeps() {
  return {
    championsDataDir: path.join(appRoot, "data", "champions"),
    readTeamDoc: () => {
      try {
        return fs.readFileSync(teamDocPath, "utf8");
      } catch (error) {
        return `構築文書を読めませんでした: ${String(error)}`;
      }
    },
    appendBattleLog: () => {},
    adviceModel: process.env.ADVICE_MODEL ?? "gpt-5.4-mini",
    adviceReasoningEffort: (process.env.ADVICE_REASONING_EFFORT ?? "none") as never,
    requestTimeoutMs: Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 20_000),
    appendMemoryNotes: () => {}
  };
}

async function adviceForTarget(
  target: EvalTarget,
  mode: "logged" | "live",
  loggedDetails: Map<string, { reason: string; risk: string; speech: string }>
): Promise<AdviceUnderTest> {
  if (mode === "logged") {
    const detail = loggedDetails.get(`${target.battleId}\n${target.transcript}`);
    return {
      kind: target.logged.actionKind,
      command: target.logged.actionCommand,
      reason: detail?.reason ?? "",
      risk: detail?.risk ?? "",
      speech: detail?.speech ?? ""
    };
  }
  const result = await runBattleAdviceWorkflow(buildWorkflowDeps(), {
    state: target.preState,
    transcript: target.transcript,
    memoryContext: "",
    conversationIntent: "battle"
  });
  return {
    kind: result.action.kind,
    command: result.action.command,
    reason: result.action.reason,
    risk: result.action.risk,
    speech: result.speech
  };
}

// 劣位技チェック: move助言のとき、場のポケモンの各技の概算最大%を評価スクリプト内で
// 独立に計算し、選んだ技と最大打点のギャップを記録する(タイプ相性と種族値ベースの概算)。
function damageGapForAdvice(
  store: LocalDataStore,
  state: BattleState,
  advice: AdviceUnderTest
): TurnResult["deterministic"]["damageGap"] {
  if (advice.kind !== "move" || state.phase !== "battle") return null;
  const attacker = state.ownTeam.find((pokemon) => pokemon.active) ??
    state.ownTeam.find((pokemon) => pokemon.name === state.activeOwn);
  const defender = store.getPokemon(state.activeOpponent);
  const attackerLocal = attacker ? store.getPokemon(attacker.name) : null;
  if (!attacker || !defender || !attackerLocal) return null;
  const profile = statProfileFromNotes(attacker.notes);
  const attackerStats = calculateChampionsStats({
    baseStats: attackerLocal.baseStats,
    statPoints: profile.statPoints as never,
    nature: profile.nature as never
  });
  const defenderStats = calculateChampionsStats({ baseStats: defender.baseStats, statPoints: {}, nature: {} });
  const estimates: Array<{ command: string; percentMax: number }> = [];
  for (const move of attacker.moves) {
    if (!move.value) continue;
    const local = store.getMove(move.value);
    if (!local || local.category === "Status" || local.basePower <= 0) continue;
    const attack = local.category === "Physical" ? attackerStats.atk : attackerStats.spa;
    const defense = local.category === "Physical" ? defenderStats.def : defenderStats.spd;
    const stab = attackerLocal.types.includes(local.type) ? 1.5 : 1;
    const effectiveness = typeEffectiveness(local.type, defender.types);
    const base = Math.floor(Math.floor(Math.floor(((Math.floor(100 / 5) + 2) * local.basePower * attack) / defense) / 50) + 2);
    const max = Math.floor(base * stab * effectiveness);
    estimates.push({ command: move.value, percentMax: Number(((max / defenderStats.hp) * 100).toFixed(1)) });
  }
  if (estimates.length === 0) return null;
  const chosen = estimates.find((entry) => entry.command === advice.command);
  const best = estimates.reduce((left, right) => (right.percentMax > left.percentMax ? right : left));
  if (!chosen) return null;
  return { command: chosen.command, percentMax: chosen.percentMax, bestCommand: best.command, bestPercentMax: best.percentMax };
}

// ---- 集計とレポート ----------------------------------------------------------

function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function summarize(turns: TurnResult[]) {
  const judged = turns.filter((turn) => turn.judgeMean);
  const verdicts = turns.flatMap((turn) => turn.judge ?? []).map((score) => score.verdict);
  const dominated = turns.filter(
    (turn) => turn.deterministic.damageGap && turn.deterministic.damageGap.percentMax < turn.deterministic.damageGap.bestPercentMax * 0.5
  );
  return {
    turnCount: turns.length,
    judgedTurnCount: judged.length,
    tactics: meanOf(judged.map((turn) => turn.judgeMean!.tactics)),
    safety: meanOf(judged.map((turn) => turn.judgeMean!.safety)),
    consistency: meanOf(judged.map((turn) => turn.judgeMean!.consistency)),
    overall: meanOf(judged.map((turn) => turn.judgeMean!.overall)),
    verdictBetterRate: verdicts.length ? Number((verdicts.filter((verdict) => verdict === "better").length / verdicts.length).toFixed(2)) : 0,
    verdictWorseRate: verdicts.length ? Number((verdicts.filter((verdict) => verdict === "worse").length / verdicts.length).toFixed(2)) : 0,
    invariantViolationTurns: turns.filter((turn) => turn.deterministic.invariantViolations.length > 0).length,
    noteInActiveBattleTurns: turns.filter((turn) => turn.deterministic.noteInActiveBattle).length,
    dominatedMoveTurns: dominated.length,
    errorTurns: turns.filter((turn) => turn.error).length
  };
}

function gitRev(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: appRoot }).toString().trim();
  } catch {
    return "unknown";
  }
}

function printSummary(label: string, summary: ReturnType<typeof summarize>): void {
  console.log(`\n== ${label} ==`);
  console.log(`  対象ターン: ${summary.turnCount} (判定済み ${summary.judgedTurnCount}, エラー ${summary.errorTurns})`);
  console.log(`  戦術 ${summary.tactics} / 安全 ${summary.safety} / 整合 ${summary.consistency} / 総合 ${summary.overall} (5点満点)`);
  console.log(`  判定verdict: 助言優位 ${Math.round(summary.verdictBetterRate * 100)}% / 判定側優位 ${Math.round(summary.verdictWorseRate * 100)}%`);
  console.log(`  不変条件違反 ${summary.invariantViolationTurns}ターン / 対戦中note ${summary.noteInActiveBattleTurns}ターン / 劣位技選択 ${summary.dominatedMoveTurns}ターン`);
}

function compareReports(pathA: string, pathB: string): void {
  const reportA = JSON.parse(fs.readFileSync(pathA, "utf8"));
  const reportB = JSON.parse(fs.readFileSync(pathB, "utf8"));
  printSummary(`${reportA.label} (${reportA.gitRev})`, reportA.summary);
  printSummary(`${reportB.label} (${reportB.gitRev})`, reportB.summary);
  console.log("\n== 差分 (B - A) ==");
  for (const key of ["tactics", "safety", "consistency", "overall"] as const) {
    const delta = Number((reportB.summary[key] - reportA.summary[key]).toFixed(2));
    console.log(`  ${key}: ${delta > 0 ? "+" : ""}${delta}`);
  }
  for (const key of ["invariantViolationTurns", "noteInActiveBattleTurns", "dominatedMoveTurns"] as const) {
    const delta = reportB.summary[key] - reportA.summary[key];
    console.log(`  ${key}: ${delta > 0 ? "+" : ""}${delta}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.compare) {
    compareReports(options.compare[0], options.compare[1]);
    return;
  }
  if (!options.dryRun && !process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. --dry-run なら判定モデルなしで実行できます。");
    process.exit(1);
  }
  const store = createLocalDataStore(path.join(appRoot, "data", "champions"));
  const targets = loadTargets(options);
  const loggedDetails = options.mode === "logged" ? loadLoggedDetails() : new Map<string, { reason: string; risk: string; speech: string }>();
  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? "gpt-5.4-mini";
  const judgeEffort = process.env.EVAL_JUDGE_REASONING_EFFORT ?? "low";
  const client = options.dryRun ? null : new OpenAI();
  console.log(
    `mode=${options.mode} turns=${targets.length} panel=${options.panel} judge=${judgeModel}(${judgeEffort})` +
    `${options.mode === "live" ? ` advice=${process.env.ADVICE_MODEL ?? "gpt-5.4-mini"}` : ""}${options.dryRun ? " [dry-run]" : ""}`
  );

  const results: TurnResult[] = [];
  const concurrency = 4;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        const label = `${target.opponentName || target.battleId.slice(0, 8)}戦 turn ${target.turnIndex}`;
        const started = Date.now();
        try {
          const advice = await adviceForTarget(target, options.mode, loggedDetails);
          const deterministic = {
            invariantViolations: collectInvariantViolations(advice, target.preState),
            noteInActiveBattle:
              advice.kind === "note" && target.preState.phase === "battle" && target.preState.status === "active",
            damageGap: damageGapForAdvice(store, target.preState, advice)
          };
          let judge: JudgeScore[] | null = null;
          if (client) {
            const boardContext = buildJudgeBoardContext(store, target.preState);
            judge = await judgeAdvice(client, judgeModel, judgeEffort, target, advice, boardContext, options.panel);
          }
          const judgeMean = judge && judge.length > 0
            ? {
                tactics: meanOf(judge.map((score) => score.tactics)),
                safety: meanOf(judge.map((score) => score.safety)),
                consistency: meanOf(judge.map((score) => score.consistency)),
                overall: meanOf(judge.flatMap((score) => [score.tactics, score.safety, score.consistency]))
              }
            : null;
          results.push({
            label,
            battleId: target.battleId,
            turnIndex: target.turnIndex,
            transcript: target.transcript,
            advice,
            deterministic,
            judge,
            judgeMean,
            elapsedMs: Date.now() - started
          });
          const scoreText = judgeMean ? `総合${judgeMean.overall}` : "judged-skip";
          console.log(`[OK] ${label} ${advice.kind}:${advice.command.slice(0, 30)} → ${scoreText}`);
        } catch (error) {
          results.push({
            label,
            battleId: target.battleId,
            turnIndex: target.turnIndex,
            transcript: target.transcript,
            advice: { kind: "error", command: "", reason: "", risk: "", speech: "" },
            deterministic: { invariantViolations: [], noteInActiveBattle: false, damageGap: null },
            judge: null,
            judgeMean: null,
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - started
          });
          console.log(`[NG] ${label} → ${error instanceof Error ? error.message : error}`);
        }
      }
    })
  );

  results.sort((left, right) => left.battleId.localeCompare(right.battleId) || left.turnIndex - right.turnIndex);
  const summary = summarize(results);
  const label = options.label ?? `${options.mode}-${gitRev()}`;
  const report = {
    label,
    createdAt: new Date().toISOString(),
    gitRev: gitRev(),
    mode: options.mode,
    adviceModel: options.mode === "live" ? process.env.ADVICE_MODEL ?? "gpt-5.4-mini" : "(logged)",
    judgeModel: options.dryRun ? null : judgeModel,
    judgeEffort: options.dryRun ? null : judgeEffort,
    panel: options.panel,
    summary,
    turns: results
  };
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `${label}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(label, summary);
  console.log(`\nreport: ${path.relative(appRoot, reportPath)}`);
}

await main();
