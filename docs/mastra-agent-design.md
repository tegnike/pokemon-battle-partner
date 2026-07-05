# Mastra Agent Design

作成日: 2026-06-30

この文書は Mastra 採用の設計意図と、現行workflowの考え方をまとめる。実装仕様の正は [current-spec.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/current-spec.md) とする。

## 目的

Pokemon Battle Partner の対戦判断を、単発LLM呼び出しではなく Mastra workflow と deterministic step の組み合わせで扱う。

狙い:

- 自然言語理解、状態更新、候補生成、最終判断、検証を分離する
- LLMの古い一般知識より、ローカルデータとマスターが追加した環境知識を優先する
- 毎ターンの対戦中レスポンスは低遅延にする
- 選出画面や反省会は多少遅くても文脈と比較を重視する
- `workflowTrace` で、どのstepが何を判断したか追えるようにする

## 採用方針

Mastraは「自律エージェント」ではなく「AI workflow runtime」として使う。

LLMに任せるもの:

- マスターの自由文からの事実抽出
- 候補の比較が必要な選出判断
- 最終的な発話、理由、リスクの自然文生成
- 雑談、記憶依頼、反省会の自然な応答

deterministicに寄せるもの:

- BattleState正規化
- 名前解決
- ローカルポケモンデータ参照
- ポケモン別ナレッジ読み込み
- 基本ダメージ計算
- 選出数と `ownTeam` 保持のガード
- ローカルデータと矛盾するタイプ・特性説明の補正

## 現行Workflow

`src/mastra/battleWorkflow.ts` の `battleAdviceWorkflow` が現行の中心。

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

### normalizeInput

- `BattleState` を正規化
- 構築文書を要約した `teamDoc` を準備
- conversation intent を `battle` / `chat` / `memory` に分類
- trace id と timings を初期化

### extractBattleFacts

`extractBattleFactsAgent` が、入力文から事実だけを `BattleFacts` として抽出する。

判断や助言はしない。自分の6体に存在しないポケモン名は、原則として相手側情報として扱う。

### resolveNames

ローカルaliasとfuzzy補完で、ポケモン名や技名をローカルIDへ寄せる。

同時に `localKnowledge` を生成する。

`localKnowledge` に含むもの:

- 今回の相談に関係するポケモンのタイプ
- 特性
- じめん無効かどうか
- 相手パーティにいるポケモンの `data/knowledge/pokemon/{id}.md`

ポケモン別Markdownは、相手パーティに該当ポケモンがいる場合だけ読む。最大で相手6体分だが、ファイルが存在するものだけが追加される。

各Markdownは見出しのポケモン専用として扱う。たとえばゲンガーの `みちづれ` 注意は、ゲンガー対面やゲンガーの型読みには使うが、ミミロップなど別ポケモンのリスク説明へ流用しない。

### updateBattleState

抽出されたfactsを deterministic に `BattleState` へ反映する。

- 相手6体
- 相手選出
- 自分選出
- 現在対面
- HP%
- 状態異常
- 技、特性、持ち物
- メモ

相手の見せ合い6体は `opponentMentionedPokemon`、実際に場に出た相手だけは `opponentSelectedPokemon` として扱う。6体入力を選出済みにしない。相手を倒した発話は `faintedPokemon` として抽出し、状態更新でHP 0・ひんしにする。相手がきあいのタスキ/きあいのハチマキ等で持ちこたえた場合はHP 1と持ち物 confirmed にする。

### damageCalc

明示的なダメ計依頼がある場合、ローカルデータで簡易ダメージ計算を行う。

対戦中の高速候補生成では、現在場の自分ポケモンが覚えている技を相手現在場へ撃った場合の簡易ダメージも使う。

### generateCandidates

ここは遅延と品質のバランスで分岐する。

選出画面、反省会、雑談:

- `generateCandidatesAgent` を使う
- 複数案を比較する
- 品質重視

対戦中の次の一手:

- LLM候補生成は使わない
- ローカル候補生成を使う
- 現在対面と簡易ダメ計から候補を作る
- `activeOwn` が空の場合は、直前の技・交代・選出先頭から場の自分ポケモンを推定する
- `move` 候補は場の自分ポケモンが覚えている技だけに制限する
- 低遅延重視

### chooseFinalAction

`chooseFinalActionAgent` が、候補、状態、構築メモ、会話記憶、`localKnowledge` を見て最終応答を作る。

現行では、LLMに `updatedState` 全体を返させない。最終判断agentは次だけを返す。

- `action`
- `speech`
- `memo`
- 選出時の `selectedOwnPokemon`

状態更新はworkflow側で行う。

### extractMemoryNotes

雑談、記憶依頼、反省会では長期記憶候補を抽出する。

通常の `active` 対戦中ターンでは、レスポンス速度を優先して同期抽出をスキップする。

### guardAdvice

LLM出力を返す前に deterministic guard を通す。

主な検証と補正:

- `ownTeam` は常に6体を保持する
- 選出時は3体だけ `selected: true`
- 選出時の `action.command`、`speech`、`ownTeam.selected` を揃え、1体目を `activeOwn` にする
- 対戦中に選出指示へ戻った場合は補正
- 対戦相談で最終出力が `note` でも、候補に技・交代がある場合は一手へ補正
- 場の自分ポケモンが覚えていない `move` が返った場合は、候補内の有効な一手へ補正する
- ローカルデータと矛盾するタイプ・特性説明を補正

## データ優先順位

判断で参照する情報の優先順位は以下。

1. マスターの最新入力
2. 現在の `BattleState`
3. `data/champions/*` のローカル公式データ
4. `data/knowledge/pokemon/*.md` のポケモン別環境知識
5. 構築文書の要約
6. 直近20ターンと関連長期記憶
7. LLMの一般知識

LLMの一般知識は最後に置く。たとえば「昔のゲンガーはふゆう」のような知識がローカルデータと矛盾する場合、ローカルデータを正とする。

## ポケモン別ナレッジ

形式:

```text
data/knowledge/pokemon/{pokemonId}.md
```

例:

```text
data/knowledge/pokemon/gengar.md
```

用途:

- 環境で流行っている型
- 持ち物や技の注意点
- そのポケモン固有の対面リスク
- 対面での立ち回り
- マスターが後から追加する知見

適用範囲:

- `data/knowledge/pokemon/gengar.md` はゲンガー専用
- 別ポケモンの判断に使いたい汎用知識は、個別ポケモンMarkdownへ混ぜない
- `localKnowledge` では「各見出しのポケモン専用」と明示してプロンプトへ渡す

この情報は公式データではなく環境知識として扱う。タイプ、特性、技威力などの基礎データは `data/champions/*` を優先する。

## 速度方針

以前は1相談で最大4回LLMを直列実行していた。

```text
facts抽出
候補生成
最終判断
記憶抽出
```

現在は対戦中だけ高速化している。

```text
対戦中: facts抽出 + ローカル候補 + 最終判断
選出: facts抽出 + 深い候補生成 + 最終判断
反省会/雑談: 文脈と記憶重視
```

遅延調査は `workflowTrace.timings` を見る。

## Trace

`/api/advise` のレスポンスと `data/battles/YYYY-MM-DD.jsonl` には `workflowTrace` を残す。

主な項目:

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

問題調査では、まず `workflowTrace.facts`、`workflowTrace.localKnowledge`、`workflowTrace.candidates`、`workflowTrace.guard` を見る。

## まだ弱いところ

- ダメージ計算のタイプ相性は必要に応じて拡張中
- 壁、天候、持ち物補正、特性補正、能力ランク、火傷などは未完全対応
- 「自分が覚えていない技を指示しない」などの一部guardは今後強化余地あり
- 対戦中の長期記憶抽出は同期では走らないため、重要な学びは雑談/反省会/明示的な記憶依頼で保存する運用

## 非目標

- 対戦中に外部サイト/APIへアクセスすること
- LLMに全状態更新を丸投げすること
- 完全なダメージ計算ツールを初期段階で作ること
- 自律的な長期戦略探索

## 関連ドキュメント

- [current-spec.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/current-spec.md)
- [architecture.md](/Users/user/WorkSpace/pokemon-battle-partner/docs/architecture.md)
- [README.md](/Users/user/WorkSpace/pokemon-battle-partner/README.md)
