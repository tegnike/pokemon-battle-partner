# Architecture

更新日: 2026-07-05

この文書は、コード実装から起こしたアーキテクチャ仕様。機能仕様の正は [current-spec.md](current-spec.md)、Mastra設計の意図は [mastra-agent-design.md](mastra-agent-design.md) を参照する。この文書は既存2文書に書かれていない「コード構造・API・信頼性設計・名前解決・テスト」を扱う。

## 技術スタック

| 領域 | 技術 |
| --- | --- |
| フロントエンド | React 19 + Vite 7 (TypeScript) |
| バックエンド | Express 5 (tsx watch で起動) |
| AIランタイム | Mastra (`@mastra/core`) + `ai` SDK + `@ai-sdk/openai` |
| LLM | OpenAI `gpt-5.4-mini`(判断) / `gpt-4o-transcribe`(文字起こし) |
| スキーマ検証 | Zod 4 (構造化出力の検証) |
| ポケモンデータ | `@pkmn/dex` / `@pkmn/data` (Gen 9)、`@smogon/calc` は導入済み未使用 |
| 音声アップロード | Multer (multipart / メモリバッファ) |

## モジュールマップ

```text
src/
├── main.tsx              # Reactエントリ。`/obs` パスでObsSpeechOverlayに分岐
├── App.tsx               # メインUI (対戦セレクタ、相談エリア、対面表示、チーム欄、履歴)
├── domain.ts             # BattleState/PokemonState定義、normalizeBattleState、createOwnTeam(固定6体)
├── fieldStatus.ts        # 場の効果の正規定義テーブル(fieldDefinitions)とUI向けサマリ
├── fieldState.ts         # 構造化FieldState。field文字列のparse/serialize/観測マージ(全置換しない)
├── battles/store.ts      # data/battle-sessions/{battleId}.json のCRUD
├── memory/store.ts       # 会話記憶 (recent-turns / notes / summaries) の保存と簡易検索
├── champions/statCalc.ts # Champions式ステータス計算 (Lv50、個体値31固定、能力ポイント)
└── mastra/
    ├── battleWorkflow.ts # 主処理。workflow全step、guard、プロンプト構築 (最大ファイル)
    ├── schemas.ts        # BattleFacts/AdviceResult等のZodスキーマ
    ├── localData.ts      # ローカルデータストア。名前解決 (alias + fuzzy + メガfallback)
    ├── megaEvolution.ts  # メガシンカ名の解釈とチーム状態への適用
    ├── damage.ts         # 簡易ダメージ計算 (タイプ相性表を含む)
    ├── turnEvaluation.ts # 両面ターン評価。被弾見積もり・交代先受け出しリスク・補助技候補
    └── tools.ts          # Mastra tool定義

server/index.ts           # Express。全APIエンドポイント、文字起こし、AITuberKit送信、ログ追記

scripts/
├── eval-advice.ts                      # 助言品質評価ハーネス (docs/advice-eval.md 参照)
├── generate-champions-data.ts          # @pkmn/dexからdata/champions/*.jsonを生成
├── import-champions-move-availability.ts # Champions技可用性の取り込み
├── import-move-ja-aliases.ts           # 日本語技名aliasの取り込み
├── import-pokemon-ja-aliases.ts        # PokeAPI種族名から日本語aliasの取り込み
└── export-battle-replay-fixtures.ts    # data/battles/*.jsonl → tests/fixtures/battle-replays.json
```

## 実行構成

- フロント: Vite dev server (`npm run dev:client`、`127.0.0.1` bind)
- API: Express (`npm run dev:server`、default port 8787、`PORT` で変更)
- Viteが `/api/*` をExpressへproxyする (`VITE_API_PROXY_TARGET`)
- `npm run dev` はconcurrentlyで両方を起動する
- フロントのBattleStateはlocalStorageにも保存され、サーバー側 `data/battle-sessions/` と二重に永続化される

## APIエンドポイント一覧

`server/index.ts` 実装。

| Method | Path | 役割 |
| --- | --- | --- |
| POST | `/api/advise` | 相談本体。BattleState+入力文→workflow実行→AdviceResult。成功時にログ追記・セッション保存・speech公開・AITuberKit送信 |
| POST | `/api/transcribe` | 音声(multipart `audio`)→日本語テキスト。`gpt-4o-transcribe`、言語 `ja`、対戦文脈プロンプト付き |
| GET | `/api/battles` | 対戦セッション一覧 |
| POST | `/api/battles` | 新規対戦作成 |
| GET | `/api/battles/:battleId` | セッション読み込み |
| PUT | `/api/battles/:battleId` | BattleState全保存 |
| PATCH | `/api/battles/:battleId` | 相手名・status・phaseの部分更新 |
| GET | `/api/speech` | 最新speech取得 (OBSオーバーレイがポーリング) |
| POST | `/api/speech` | speechの手動更新 (動作確認用) |
| GET | `/api/team-doc` | 読み込み済み構築文書の確認 |
| GET | `/api/champions-data/metadata` | ローカルデータ生成メタ情報 |
| GET | `/api/champions-data/pokemon/:name` | 日本語名→図鑑番号解決 (UIのsprite表示用) |

## LLM信頼性設計 (リトライとフォールバック)

### 構造化出力のリトライ

`generateObjectWithRetry()` ([battleWorkflow.ts:195](../src/mastra/battleWorkflow.ts)) が、構造化出力を使う3箇所 (facts抽出、候補生成、最終判断) を包む。

- スキーマ不一致・出力欠落・例外の場合、**最大2回試行** (リトライ1回)
- 2回とも失敗したら `null` を返し、呼び出し側のローカルフォールバックに委ねる
- ユーザー起因の中断 (`AbortSignal`) はリトライせず即座に投げる

stepごとのフォールバック:

| step | LLM失敗時の挙動 |
| --- | --- |
| extractBattleFacts | 空のfactsで続行。名前解決とローカルデータで補える範囲だけ更新 |
| generateCandidates | ローカル候補生成のみで続行 |
| chooseFinalAction | 候補プールの最良ローカル候補を採用、短い定型speechで返す |

### タイムアウト

- LLM呼び出し: `LLM_REQUEST_TIMEOUT_MS` (default 20秒)。`AbortSignal.timeout` とユーザー中断シグナルを `AbortSignal.any` で合成する ([battleWorkflow.ts:180](../src/mastra/battleWorkflow.ts))
- 文字起こし: 20秒固定

### 文字起こしのリトライ

`transcribeWithRetry()` ([server/index.ts:203](../server/index.ts)):

- 最大2回試行。リトライ対象は429/500/503/UNAVAILABLE/timeoutのみ (`isRetryableModelError`)
- リトライ前に700ms待機
- MIMEタイプから拡張子を補完 (webm/wav/mp3/mp4/m4a/ogg対応、不明はwebm扱い)

## 名前解決 (音声入力の表記ゆれ吸収)

`src/mastra/localData.ts` の `resolveAlias()` / `resolvePokemonId()` / `resolveMoveId()`。

照合キーの正規化 (`normalizeLookupKey`):

1. 小文字化 + NFKC正規化
2. `・` 空白 `.` `_` `'` `-` を除去
3. **カタカナ→ひらがな折りたたみ** (U+30A1–U+30F6のみ)。音声認識が「ナマケル」「なまける」どちらでも返すため。長音符「ー」はカタカナ語で有意なので保持する

解決の順序:

1. alias表 (`ja-aliases.json`) との完全一致
2. **Levenshtein距離によるfuzzy補完**: キーが4文字以上のとき、距離1以内の最良候補を採用 (例: `ブリジラス` → `ブリジュラス`)
3. ポケモンID・英語名との直接一致
4. **メガfallback**: `メガ○○` が解決できない場合、`メガ` 接頭辞と末尾のX/Y (全角含む) を外してベース種で引き直す (例: 実在しない `メガスターミー` → `スターミー`)

漢字・交ぜ書き技名 (`地震` → `じしん`、`トンボ返り` 等) は生成スクリプトの手動aliasで `ja-aliases.json` に吸収する。テストは `tests/name-resolution.test.mjs`。

## メガシンカ処理

`src/mastra/megaEvolution.ts`。

- 発話中の `メガ{name}` を解釈し、ローカルデータにメガフォームが存在すればメガ名へ、存在しなければベース種へ寄せる
- 相手側: 名前を `メガ{name}` に更新し、持ち物をメガストーン扱いにする
- 自分側: 明示的にメガ進化したと分かった場合だけ名前を更新し、特性を上書きする (メタグロス → `かたいツメ`)
- factsの現在対面・選出・HP更新・ダメ計依頼すべてにメガ名の書き換えを適用し、状態の一貫性を保つ

## テストアーキテクチャ

### ユニットテスト (`npm run test`)

外部APIを呼ばない。`npm run test` は以下を直列実行する。

| テスト | 内容 |
| --- | --- |
| `tests/knowledge-files.test.mjs` | ポケモン別ナレッジMarkdownの必須見出し・最低行数・参照元URL |
| `tests/speed-comparison.test.mjs` | 素早さ計算・比較の整合性 |
| `tests/champions-data.test.mjs` | 生成済みローカルデータの整合性 |
| `tests/field-status.test.mjs` | field文字列の分類 (天候/設置物/壁など) |
| `tests/phase-regression.test.mjs` | 対戦中に選出フェーズへ巻き戻らないguard |
| `tests/name-resolution.test.mjs` | かな/カナ折りたたみ、漢字技名alias、メガfallback |
| `tests/field-state.test.mjs` | 構造化FieldStateのマージ(天候でも設置物が消えない)、解除、壁・天候のダメ計反映 |
| `tests/turn-evaluation.test.mjs` | 被弾見積もり(特性無効・トリックルーム)、交代先リスク、補助技候補、無効技ガード |

### 助言品質評価 (`npm run eval:advice`)

統合テストが「壊れていないこと」の下限検査であるのに対し、`scripts/eval-advice.ts` は「助言が良くなったか/悪くなったか」を数値化してブランチ間比較する測定器。決断ターン63件を対象に、決定的メトリクス(不変条件違反・対戦中note率・劣位技選択)と判定モデルのルーブリック採点(戦術/安全/整合)を出す。詳細は [advice-eval.md](advice-eval.md)、ベースラインは `reports/eval/`。

### 実API統合テスト (`npm run test:integration`)

`tests/integration/battle-replay.integration.mjs`。**実際のOpenAI APIを呼ぶ** (料金と時間がかかる)。

- `tests/fixtures/battle-replays.json` に記録された実対戦 (5試合75ターン) を、相談前のBattleState+入力文からworkflowで再生する
- fixtureは `npm run fixtures:replays` で `data/battles/*.jsonl` から生成する
- 実行モード:
  - 引数なし: 厳選シナリオのみ (過去の実バグ再現ターン+代表的な正常ターン、LLM呼び出し数を抑える)
  - `-- --battle <battleIdプレフィックス>`: 1試合を全ターン再生
  - `-- --all`: 75ターンすべて再生 (並列度4)

厳選シナリオは過去の実バグに対応する: 「ひんし後の『次のポケモンを選んで』で再選出に巻き戻る」(2例)、「ひんし報告で指示が空振りする」、「勝利報告に対戦指示を返す」。

全ターン共通の不変条件 (`assertInvariants`):

- `action.command` と `speech` が空でない
- speechに生の `%` 表記が漏れていない (TTS向け)
- 対戦中 (`phase=battle` かつ `status=active`) はphaseが巻き戻らず、`selection` actionを返さない
- `switch` の対象は自分の選出済み・非ひんしポケモンである
- `move` は自チームが覚えている技である

## 環境変数一覧

`.env.example` 参照。

| 変数 | default | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | (必須) | OpenAI API |
| `TRANSCRIPTION_MODEL` | `gpt-4o-transcribe` | 文字起こしモデル |
| `ADVICE_MODEL` | `gpt-5.4-mini` | 対戦判断モデル |
| `ADVICE_REASONING_EFFORT` | `none` | reasoning effort (速度優先) |
| `LLM_REQUEST_TIMEOUT_MS` | `20000` | LLM呼び出しタイムアウト |
| `PORT` | `8787` | APIサーバーポート |
| `VITE_API_PROXY_TARGET` | `http://127.0.0.1:8787` | Vite→APIのproxy先 |
| `TEAM_DOC_PATH` | `~/WorkSpace/nikechan/docs/pokemon-champions-ai-team.md` | 構築文書。起動時に読み込み、`## 最終パーティ` と `## 主要仮想敵への考え方` を抽出し約5000字に圧縮してプロンプトへ含める。無い場合はコード内のfallback構築文を使う |
| `AITUBERKIT_BASE_URL` | `http://127.0.0.1:3000` | AITuberKit発話連携 |
| `AITUBERKIT_API_KEY` / `AITUBERKIT_CLIENT_ID` | (未設定なら送信スキップ) | 同上 |
| `AITUBERKIT_SPEAK_INTERRUPT` | `true` | 発話割り込み |
| `AITUBERKIT_SPEAK_PRIORITY` | `high` | 発話優先度 |
| `AITUBERKIT_SPEAK_TIMEOUT_MS` | `3000` | 発話送信タイムアウト |

## データディレクトリ構成

```text
data/
├── champions/          # 生成済みローカル公式データ (npm run data:champions)
├── battle-sessions/    # {battleId}.json — BattleStateスナップショット (再開用)
├── battles/            # {YYYY-MM-DD}.jsonl — 相談ログ (workflowTrace込み、追記のみ)
├── knowledge/pokemon/  # {pokemonId}.md — ポケモン別環境ナレッジ
└── memory/
    ├── recent-turns.jsonl   # 直近会話ターン (助言時は最新20件を常時プロンプトへ)
    ├── notes/{scope}.jsonl  # 長期記憶 (global/preference/team/battle/opponent)
    └── summaries/{scope}.md # 人間確認用の自動サマリ
```

長期記憶の検索は、単語トークン+日本語向け4文字チャンクでスコアリングし (battleId一致とscopeでブースト)、関連上位のみをプロンプトへ含める簡易検索 (`src/memory/store.ts`)。

## 履歴ラベルの短縮

`compactActionLabel()` ([server/index.ts:252](../server/index.ts)) が、履歴表示用に長文actionを `選出理由` / `理由説明` / `状況確認` / `記憶` / `反省会` / `会話` などの一言ラベルへ短縮する。詳細は `memo` に残る。

## 関連ドキュメント

- [current-spec.md](current-spec.md) — 機能仕様の正
- [mastra-agent-design.md](mastra-agent-design.md) — Mastra採用の設計意図
- [README.md](../README.md) — セットアップとデータ生成
