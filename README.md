# Pokemon Battle Partner

ポケモンチャンピオンズの対戦中に、マスターの音声メモから盤面を整理し、ニケちゃんが次の一手だけを提案するローカルWebアプリです。

- 文字起こし: gpt-4o-transcribe
- 対戦判断: gpt-5.4-mini (`reasoning.effort=none`)

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
- `ja-aliases.json` — 日本語音声入力をShowdown IDへ寄せるalias
- `metadata.json` — 生成元とChampions用ステータス計算ルール

基礎データは `@pkmn/dex` のGen 9データから生成します。対戦中は外部APIを叩かず、このローカルJSONを参照します。

Champions用ステータス計算は [src/champions/statCalc.ts](/Users/user/WorkSpace/pokemon-battle-partner/src/champions/statCalc.ts) にあります。

- レベル50固定
- 個体値は廃止扱いで31固定として計算
- 能力ポイントは各能力最大32、合計66
- 能力ポイント1につきレベル50実数値がおおむね1上がる形で `statPoints * 2` を式へ入れる

日本語名aliasは初期状態では現構築と想定上位相手中心です。未登録名が出た場合は `scripts/generate-champions-data.ts` のaliasへ追加して再生成します。

## Mastra設計

裏側をMastra workflowへ移行する設計は [docs/mastra-agent-design.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/mastra-agent-design.md) にまとめています。

現在の実装仕様は [docs/current-spec.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/current-spec.md) にまとめています。

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
