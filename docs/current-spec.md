# Current Spec

更新日: 2026-07-01

## 概要

Pokemon Battle Partner は、Pokemon Champions の対戦中にマスターの音声またはテキスト説明を受け取り、AIニケちゃんが盤面メモ、選出、次の一手、反省会を支援するローカルWebアプリ。

操作はマスターが行う。アプリは「実際に押す一手」または「選出する3体」を短く返す。音声再生はアプリ外で用意する前提で、APIはTTS向けの自然文 `speech` を返す。

## モデル

- 文字起こし: `gpt-4o-transcribe`
- 対戦判断: `gpt-5.4-mini`
- reasoning effort: `none`

`/api/transcribe` は音声から日本語テキストを返すだけの独立処理。対戦判断は `/api/advise` で行う。

## 起動

標準:

```bash
npm run dev
```

現在よく使うポート指定:

```bash
PORT=8790 npm run dev:server
VITE_API_PROXY_TARGET=http://127.0.0.1:8790 npm run dev:client -- --port 5178
```

UI: `http://127.0.0.1:5178/`

## 画面仕様

画面上部:

- 対戦セレクタ
- 新規対戦
- 相手名入力
- `対戦中` / `反省会` 切り替え
- `選出` / `対戦` フェーズ切り替え

相談エリア:

- 録音ボタン
- テキスト入力欄
- 相談ボタン
- 相談中だけ表示される緊急停止ボタン。押すと相談前のstateへ戻し、返ってきた結果は反映しない。
- AIニケちゃんの回答カード

選出表示:

- 回答カード直下に「自分の選出」「相手の選出」サマリーを表示
- 詳細カードでは選出済みを上に並べ、枠と背景で強調
- 自分のポケモンはHP実数値表示
- 相手のポケモンは初期 `HP 100%`

## BattleState

対戦状態は `BattleState` として保持する。

- `battleId`
- `phase`: `selection` / `battle`
- `status`: `active` / `review` / `closed`
- `opponentName`
- `turn`
- `opponentTeam`
- `ownTeam`
- `activeOwn`
- `activeOpponent`
- `field`
- `latestMemo`
- `history`

自分の `ownTeam` は常に6体保持する。選出済みは `selected: true`、現在場にいるポケモンは `active: true`。選出相談では `action.command` の1体目を先発として扱い、`activeOwn` と `ownTeam.active` に設定する。

相手の `selected` は「見せ合い6体」ではなく、対戦中に実際に選出されたことが分かったポケモンだけを表す。初期の相手6体入力は `opponentMentionedPokemon` として保存し、`selected` にはしない。

## 自分の固定構築

`src/domain.ts` の `createOwnTeam()` が正。

- ガブリアス
- アシレーヌ
- メタグロス
- ウォッシュロトム
- マスカーニャ
- サザンドラ

自分側は能力ポイントと性格からHP実数値を計算し、初期状態は満タンにする。HP%更新が入った場合は `maxHp` から `currentHp` を換算する。
メタグロスは初期状態では通常形態として保持する。マスターの説明から自分側が明示的にメガ進化したと分かった場合だけ、`ownTeam` 上の名前を `メガメタグロス` に更新し、特性を `かたいツメ` にする。

## 相手情報

相手側はマスターの説明から更新する。

- 相手名
- 相手の6体
- 選出された3体
- 技、特性、持ち物
- HP%
- 状態異常
- 備考

相手名は `対戦相手はメイさんです` のような入力から抽出する。相手のポケモン名はローカルaliasと簡易fuzzy補完で正規化する。例: `ブリジラス` は `ブリジュラス` に寄せる。

「初手A」「Aを出してきた」「裏からB」は、相手の `selected: true` かつ `activeOpponent` として扱う。「Aを倒した」「Aを倒せた」「Aを落とした」「Aがひんし」は `hpPercent: 0`、`condition: ひんし` に更新する。「きあいのタスキ」「気合のタスキ」「きあいのハチマキ」などで相手が持ちこたえた/耐えた場合は、相手の `hpPercent: 1` と持ち物 confirmed を設定する。

## 対戦セッション

対戦ごとの状態は以下に保存する。

```text
data/battle-sessions/{battleId}.json
```

API:

- `GET /api/battles`
- `POST /api/battles`
- `GET /api/battles/:battleId`
- `PUT /api/battles/:battleId`
- `PATCH /api/battles/:battleId`

対戦後の反省会は同じ `BattleState` と履歴を参照し、`status = review` で対戦指示ではなく振り返りを返す。

## 会話記憶

会話記憶は対戦状態とは別に保存する。

```text
data/memory/recent-turns.jsonl
data/memory/notes/*.jsonl
data/memory/summaries/*.md
```

助言時は直近20ターンを常に含め、長期記憶は現在入力と `battleId` に関連するものだけを簡易検索で含める。

対戦中の高速化のため、通常の `active` 対戦ターンでは長期記憶抽出を同期実行しない。雑談、記憶依頼、反省会では記憶抽出を行う。

## ローカルデータ

Pokemon Champions用の基礎データは以下を参照する。

```text
data/champions/pokemon.json
data/champions/moves.json
data/champions/abilities.json
data/champions/items.json
data/champions/natures.json
data/champions/pokemon-ja-aliases.json
data/champions/ja-aliases.json
```

生成:

```bash
npm run data:champions
npm run data:champions:refresh # 外部のChampions可用性・日本語技名aliasも更新する場合
```

対戦中は外部APIを叩かず、ローカルデータを使う。タイプ、特性、種族値、技威力、技タイプはこのデータを優先する。LLMの古い一般知識よりローカルデータを優先する。
ポケモン日本語名は `data/champions/pokemon-ja-aliases.json` の通常種族名と手動補正をマージして `ja-aliases.json` に保存する。メガシンカ、リージョンフォーム、特殊フォームなどのフォーム名は手動補正で補う。
`moves.json` は `@pkmn/dex` Gen 9 の技データを土台にし、`data/champions/move-availability.json` から `usableInChampions` を付与する。`true` はChampionsで使用可能、`false` はChampionsで使用不可、`null` は可用性表に存在しない未確認技を表す。技データ自体は削らず、対戦判断では使用可能フラグを優先材料として扱う。
日本語技名は `data/champions/move-ja-aliases.json` と手動補正をマージして `ja-aliases.json` に保存する。
`moves.json` には技の `secondary` / `secondaries` / `boosts` / `self` などの追加効果も保存する。対戦ログから実際に使われた技が分かり、かつ追加効果が100%発動する能力変化・状態異常の場合だけ、deterministic に `statChanges` / `statuses` へ反映する。ランダム追加効果は自動確定しない。

## ポケモン別ナレッジ

環境知識やマスターが後から教える注意点は、ポケモン別Markdownとして保存する。

```text
data/knowledge/pokemon/{pokemonId}.md
```

例:

```text
data/knowledge/pokemon/gengar.md
```

読み込み条件:

- 相手パーティにそのポケモンがいる
- 発話で相手側のポケモンとして出た
- 現在対面の相手として出た

最大で相手パーティ6体分を読み込む。ただし、ファイルが存在するものだけ読み込む。

適用範囲:

- 各Markdownは、そのファイル名・見出しに対応するポケモン専用の知識として扱う
- ゲンガーの `みちづれ` 注意を、ミミロップなど別ポケモンのリスク説明へ流用しない
- 相手パーティ全体に関わる一般論を入れたい場合は、個別ポケモンファイルではなく別のパーティ/環境用ナレッジとして分ける

用途:

- タスキ、みちづれ、おにびなどの流行型注意
- 対面での立ち回り注意
- ローカル公式データにはない環境知識

ポケモン別ナレッジは、公式データのタイプ・特性・技情報とは分けて扱う。最終判断プロンプトには「各見出しのポケモン専用」として渡し、現在対面と異なるポケモンの型情報を混ぜない。

## localKnowledge

`localKnowledge` は `/api/advise` のworkflow内で生成され、最終判断プロンプトへ渡される。

含む情報:

- 今回の相談に関係するポケモンのタイプ
- 特性
- じめん無効かどうか
- 相手パーティに紐づくポケモン別Markdown

例:

```text
## この相談で参照すべきローカルポケモンデータ
- ゲンガー: types=Ghost/Poison; abilities=Cursed Body; じめん無効ではない

## 相手パーティに紐づくポケモン別ナレッジ（各見出しのポケモン専用）
### ゲンガー（適用対象: ゲンガー の型・行動・対面リスクのみ。他のポケモンには転用しない）
...
```

## ダメージ計算

簡易ローカルダメージ計算は `src/mastra/damage.ts` にある。

現在の前提:

- レベル50
- Champions用ステータス計算
- 個体値は廃止扱いだが、計算上は31固定
- 能力ポイントは各能力最大32、合計66
- 実数値は `HP = 種族値 + 75 + 能力ポイント`、HP以外は `floor((種族値 + 20 + 能力ポイント) * 性格補正)` 相当
- タイプ相性は現状必要分から拡張していく

対戦中は、自分の現在場ポケモンの技を相手現在場ポケモンへ当てた簡易ダメージを候補生成に使う。ゲンガー対ガブリアスのようなケースでは、`じしん` が通るかをローカルデータとダメ計で判断する。

## Mastra Workflow

`src/mastra/battleWorkflow.ts` の `battleAdviceWorkflow` が主処理。

流れ:

```text
normalizeInput
extractBattleFacts
resolveNames
updateBattleState
damageCalc
generateCandidates
chooseFinalAction
extractMemoryNotes
guardAdvice
```

### extractBattleFacts

マスターの入力から事実だけを抽出する。

- フェーズ
- 相手名
- 相手ポケモン
- 選出
- 現在対面
- HP更新
- 状態異常
- 技、特性、持ち物
- ダメ計依頼
- メモ

### resolveNames

ローカルaliasとfuzzy補完で名前を正規化する。同時に `localKnowledge` を生成する。

### updateBattleState

抽出事実をdeterministicに `BattleState` へ反映する。

### generateCandidates

選出画面、反省会、雑談では深い候補生成を使う。対戦中の次の一手では高速化のため、ローカル候補生成を使う。

対戦中のローカル候補生成:

- 現在対面を見る
- `activeOwn` が空の場合は、直前の技・交代・選出先頭から場の自分ポケモンを推定する
- 自分の技ごとに簡易ダメ計
- 最も通る技を候補にする
- `move` 候補は場の自分ポケモンが覚えている技だけに制限する。控えの技は `switch` なしに指示しない。
- `activeOwn` / `activeOpponent` と選出済みの控えが分かる場合は、控えの最良打点から `switch` 候補を材料として追加する。候補順やローカル計算だけで交代を固定せず、最終判断はAIが相手の自然な行動、こちらのHP、温存価値、リスクを含めて行う。
- 候補理由にダメージレンジを含める

### chooseFinalAction

最終的な一手、セリフ、メモを返す。対戦中は次の一手だけに絞る。選出画面では自分の6体から3体を選ぶ。

### guardAdvice

LLM出力を返す前に deterministic guard を通す。

- 自分の `ownTeam` は6体のまま維持
- 選出時は `command`、`speech`、`ownTeam.selected` を同じ3体に揃え、1体目を `activeOwn` にする
- 対戦中に選出指示へ戻った場合は補正
- 対戦相談で最終出力が `note` でも、候補に技・交代がある場合は一手へ補正
- `わかりました。地震でいきます。` のように、マスターが前回の指示を実行すると報告しているだけの場合は `note` として短く受け、新しい技指示や復唱指示を出さない
- 場の自分ポケモンが覚えていない `move` が返った場合は、候補内の有効な一手へ補正する
- ローカルデータと矛盾するタイプ・特性説明を補正

## 速度方針

以前は1回の相談で最大4回LLMを直列実行していた。

- facts抽出
- 候補生成
- 最終判断
- 記憶抽出

現在は、急ぐ対戦中だけ高速パスを使う。

- 対戦中: facts抽出 + ローカル候補 + 最終判断
- 選出画面: facts抽出 + 深い候補生成 + 最終判断
- 反省会/雑談: 記憶や文脈を重視

実測例:

```text
対戦中: 約4秒
選出画面: 約8秒前後
```

## AdviceResult

`/api/advise` は主に以下を返す。

- `updatedState`
- `action.kind`: `selection` / `move` / `switch` / `note`
- `action.command`
- `action.reason`
- `action.risk`
- `action.confidence`
- `speech`
- `memo`
- `workflowTrace`

`speech` は音声再生向けのAIニケちゃんの自然文。

AITuberKit連携を設定している場合、サーバーは相談結果の保存後に `speech` を AITuberKit の `POST /api/v1/speak` へ送る。外部連携モード（WebSocket）はAITuberKit側から外部サーバーへ入力を渡して応答を受ける用途なので、このアプリで生成済みのセリフを喋らせる用途ではAPI direct speakを使う。

発話送信の環境変数:

- `AITUBERKIT_BASE_URL` default `http://127.0.0.1:3000`
- `AITUBERKIT_API_KEY`
- `AITUBERKIT_CLIENT_ID`
- `AITUBERKIT_SPEAK_INTERRUPT` default `true`
- `AITUBERKIT_SPEAK_PRIORITY` default `high`
- `AITUBERKIT_SPEAK_TIMEOUT_MS` default `3000`

`AITUBERKIT_API_KEY` と `AITUBERKIT_CLIENT_ID` が未設定の場合は、相談結果の生成・保存を続け、発話送信だけスキップする。AITuberKit送信の結果は `/api/advise` の `voiceDelivery` に含める。

履歴表示と `history.action` は一言ラベルを優先する。会話・理由説明などの長文は `選出理由` / `理由説明` / `状況確認` / `会話` のように短縮し、詳細は `memo` に残す。

## ログ

相談ログ:

```text
data/battles/YYYY-MM-DD.jsonl
```

各ログには `workflowTrace` を含む。

主なtrace:

- `facts`
- `resolvedNames`
- `damageCalcs`
- `timings`
- `localKnowledge`
- `memoryContext`
- `memoryNotes`
- `candidates`
- `agentToolCalls`
- `guard`

遅延調査では `workflowTrace.timings` を見る。
