# Pokemon Battle Partner

ポケモンチャンピオンズの対戦中に、マスターの音声メモから盤面を整理し、ニケちゃんが次の一手だけを提案するローカルWebアプリです。

- 文字起こし: gpt-4o-transcribe
- 対戦判断: gpt-5.4-mini (`reasoning.effort=none`)

## 判断とデータの出どころ

このアプリは、対戦中の発話やテキスト入力をAIで整理し、ローカルに持っているPokemon Champions向けデータを参照して次の一手を提案します。

- 音声入力はOpenAIの `gpt-4o-transcribe` で文字起こしします。
- 対戦状況の抽出、候補生成、最終提案、反省会、会話記憶の抽出はOpenAIの `gpt-5.4-mini` で行います。
- AIには、現在の対戦状態、直近会話、関連する長期記憶、構築文書、ローカルのポケモン・技・特性・持ち物データ、必要に応じたローカルダメージ計算結果を渡します。
- AIの回答は推論結果です。ゲーム画面を直接読み取っているわけではなく、マスターが話した内容・入力した内容・保存済み状態を元に判断します。
- 対戦判断中はPokéAPIなどの外部データAPIを叩かず、`data/champions/` のローカルJSONを参照します。

ポケモンの基礎データは `npm run data:champions` で生成します。生成元と用途は以下です。

- `@pkmn/dex` / `@pkmn/data`: 種族、タイプ、種族値、特性、技、持ち物、性格などのGen 9基礎データ
- `scripts/generate-champions-data.ts`: Pokemon Champions向けに必要な項目だけを抽出し、日本語音声入力用aliasとmetadataを付与
- `scripts/import-pokemon-ja-aliases.ts`: PokeAPIの種族多言語名から、日本語ポケモン名aliasを取り込み
- [src/champions/statCalc.ts](/Users/user/WorkSpace/pokemon-battle-partner/src/champions/statCalc.ts): Pokemon Champions想定のレベル50・能力ポイント式で実数値を計算
- [src/mastra/damage.ts](/Users/user/WorkSpace/pokemon-battle-partner/src/mastra/damage.ts): ローカルの簡易ダメージ計算。現状は必要最小限のタイプ相性・能力計算を使う補助情報です

## ポケモン画像について

このリポジトリには、ポケモンの公式画像・sprite画像を同梱していません。

Web UIでは、表示時にポケモン名を `/api/champions-data/pokemon/:name` でローカルデータへ解決し、全国図鑑番号からPokéAPI spritesリポジトリ上のPNG URLを組み立ててブラウザで読み込みます。画像取得に失敗した場合や名前を解決できない場合は、文字のフォールバック表示になります。

使用している画像URLの形式:

```text
https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{nationalDexNumber}.png
```

注意:

- PokéAPI spritesのライセンス文は、画像内容がThe Pokémon Companyの著作物であることを明記しています。
- このプロジェクトは画像を再配布せず、実行時に外部URLを参照します。
- 公式ロゴや公式画像をリポジトリに追加しないでください。
- 公開運用で問題がある場合は、sprite表示部分を外すか、自作アイコンへ差し替えてください。

## 起動

```bash
cp .env.example .env
# .env に OPENAI_API_KEY を入れる
npm install
npm run data:champions
npm run dev
```

UIのURLは起動時のVite出力を確認してください。

8787が埋まっている場合は、APIとUIを別ポートで起動できます。

```bash
PORT=8790 npm run dev:server
VITE_API_PROXY_TARGET=http://127.0.0.1:8790 npm run dev:client -- --port 5178
```

## AITuberKit発話連携

生成した `speech` は、任意で `~/WorkSpace/aituber-kit` の API に送信してキャラクターへ喋らせられます。

このアプリは AITuberKit の `POST /api/v1/speak` を使います。外部連携モード（WebSocket）は、AITuberKit側が外部サーバーへ入力を送って応答を受ける用途のため、すでにこのアプリで生成済みのセリフをそのまま発話させる用途には API の direct speak が適しています。

設定:

```bash
AITUBERKIT_BASE_URL=http://127.0.0.1:3000
AITUBERKIT_API_KEY=...
AITUBERKIT_CLIENT_ID=...
AITUBERKIT_SPEAK_INTERRUPT=true
AITUBERKIT_SPEAK_PRIORITY=high
```

`AITUBERKIT_API_KEY` と `AITUBERKIT_CLIENT_ID` が未設定の場合、相談結果の生成だけ行い、発話送信はスキップします。AITuberKit側では、API操作の受付を有効化し、同じAPIキーとClient IDを設定してください。

## OBS用セリフ表示

OBSのブラウザソースには、次のURLを指定します。

```text
http://127.0.0.1:5178/obs
```

最新のAIニケちゃんの `speech` を、白背景・黒文字・1行で枠内に表示します。表示内容は `/api/advise` の成功時に更新されます。動作確認だけなら `/api/speech` へ `{"text":"表示したいセリフ"}` をPOSTして更新できます。

## 参照する構築文書

起動時に `/Users/user/WorkSpace/nikechan/docs/pokemon-champions-ai-team.md` を読み込み、判断プロンプトに含めます。

## 保存

相談結果は `data/battles/YYYY-MM-DD.jsonl` に追記します。

## 対戦切り替え

対戦ごとの状態は `data/battle-sessions/{battleId}.json` に保存します。

- 画面上部の対戦セレクタで手動切り替え
- 新規対戦ボタンで新しい `battleId` を作成
- 相手名を保存可能。同じ相手と再戦する場合の記憶検索にも使います
- `対戦中` / `反省会` を切り替え可能

反省会では、対戦指示ではなく、その対戦の履歴・選出・メモを踏まえた振り返りとして返します。

## 会話記憶

対戦状態とは別に、ローカルの `data/memory/` に会話記憶を保存します。

- `recent-turns.jsonl` — 直近会話ターン。助言時は最新20ターンを常にプロンプトへ含めます
- `notes/*.jsonl` — 重要な長期記憶。`global` / `preference` / `team` / `battle` / `opponent` に分けて保存します
- `summaries/*.md` — scope別のMarkdownサマリ。人間が確認しやすい形で自動更新します

助言時は、直近20ターンに加えて、現在の入力に関連する長期記憶だけを簡易検索して読み込みます。

## Pokemon Champions ローカルデータ

`npm run data:champions` で `data/champions/` に以下を生成します。

- `pokemon.json` — 種族値、タイプ、特性、フォルム、メガ判定
- `moves.json` — 技タイプ、威力、分類、命中、PP、優先度
- `abilities.json` — 特性
- `items.json` — 持ち物
- `natures.json` — 性格補正
- `pokemon-ja-aliases.json` — PokeAPIから取り込んだ日本語ポケモン名alias
- `ja-aliases.json` — 日本語音声入力をShowdown IDへ寄せるalias
- `metadata.json` — 生成元とChampions用ステータス計算ルール

基礎データは `@pkmn/dex` のGen 9データから生成します。対戦判断中は外部APIを叩かず、このローカルJSONを参照します。

Champions用ステータス計算は [src/champions/statCalc.ts](/Users/user/WorkSpace/pokemon-battle-partner/src/champions/statCalc.ts) にあります。

- レベル50固定
- 個体値は廃止扱いで31固定として計算
- 能力ポイントは各能力最大32、合計66
- 実数値は `HP = 種族値 + 75 + 能力ポイント`、HP以外は `floor((種族値 + 20 + 能力ポイント) * 性格補正)` と同等になるように計算

ポケモン日本語名aliasは PokeAPI の `pokemon_species_names.csv` をローカルに取り込み、通常種族名を一括対応します。メガシンカ、リージョンフォーム、特殊フォームなどのフォーム名は、必要に応じて `scripts/generate-champions-data.ts` の手動aliasで補完します。

## Pokemon Champions ポケモン別ナレッジ

環境でよく見る型、技、持ち物、特性、性格、能力ポイント、同じチームに入りやすいポケモンは、ポケモン別Markdownとして保存します。

```text
data/knowledge/pokemon/{pokemonId}.md
```

2026-07-01時点では、Pokemon Champions シングル Season M-3 使用率上位50体分を作成しています。使用率順位はGameWith、技・持ち物・特性・性格・能力ポイント・同じチームの採用傾向はGame8の使用率ランキング詳細統計と個別育成論を参考にしています。

参照元:

- GameWith 使用率ランキング: https://gamewith.jp/pokemon-champions/555373
- Game8 使用率ランキング: https://game8.jp/pokemon-champions/779317

ナレッジファイルの最低行数、必須見出し、参照元URLは以下で確認できます。

```bash
npm run test:knowledge
```

## Mastra設計

裏側をMastra workflowへ移行する設計は [docs/mastra-agent-design.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/mastra-agent-design.md) にまとめています。

現在の実装仕様は [docs/current-spec.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/current-spec.md) にまとめています。

コード構造、APIエンドポイント、LLMリトライ/フォールバック、名前解決、テスト構成などの実装アーキテクチャは [docs/architecture.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/architecture.md) にまとめています。

参照API:

- `GET /api/champions-data/metadata`
- `GET /api/champions-data/pokemon/:name`

例:

```bash
curl http://127.0.0.1:8787/api/champions-data/pokemon/ディンルー
```

主な参照元:

- `@pkmn/dex`: https://github.com/pkmn/ps
- `@smogon/calc`: https://github.com/smogon/damage-calc
- PokéAPI: https://pokeapi.co/docs/v2
- 能力ポイント仕様確認: https://yakkun.com/ch/stat_points.htm
- Pokemon Champions 使用率/育成論: https://gamewith.jp/pokemon-champions/555373 / https://game8.jp/pokemon-champions/779317
