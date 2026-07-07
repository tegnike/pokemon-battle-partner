# 助言品質評価ハーネス (eval:advice)

更新日: 2026-07-06

`npm run eval:advice` は、AIニケちゃんの対戦助言の「質」を数値化してブランチ間で比較するための測定器。既存テストとの役割分担は以下の通り。

| 仕組み | 検査するもの |
| --- | --- |
| `npm run test` (ユニット) | 決定的ロジックの正しさ |
| `npm run test:integration` | 「壊れていないこと」の下限 (不変条件) |
| `npm run eval:advice` | 「助言が良くなったか / 悪くなったか」の相対品質 |

## 対象ターン

`tests/fixtures/battle-replays.json` の実対戦75ターンのうち、操作助言 (`selection` / `move` / `switch`) が出荷された**決断ターン63件**を母集団にする。chatや状況確認noteのターンは採点のノイズになるため既定では除外する。

サンプリング (`--limit`) は乱数を使わず均等ストライドで行う。同じ引数なら常に同じターン集合になり、ブランチ間比較が同一母集団で行われることを保証する。

## 実行モード

```bash
npm run eval:advice -- --mode logged --all --label baseline-logged  # 過去に出荷された助言を採点 (workflowは実行しない)
npm run eval:advice -- --mode live --all --label my-branch          # 現在のコードでターンを再生して採点
npm run eval:advice -- --dry-run                                    # API不要。決定的メトリクスのみ
npm run eval:advice -- --compare reports/eval/a.json reports/eval/b.json  # レポート2枚の差分表示
```

主なオプション: `--limit N` (既定16)、`--all` (63ターン全部)、`--battle <battleIdプレフィックス>`、`--panel N` (判定モデルの人数、既定1、最大3)、`--label <レポート名>`。

環境変数: `EVAL_JUDGE_MODEL` (既定 `gpt-5.4-mini`)、`EVAL_JUDGE_REASONING_EFFORT` (既定 `low`)。liveモードの助言側は本番と同じ `ADVICE_MODEL` / `ADVICE_REASONING_EFFORT` を使う。

## メトリクス

### 決定的メトリクス (API不要)

- **不変条件違反**: 統合テストの `assertInvariants` と同じ規則 (%リーク、対戦中selection、未選出への交代、覚えていない技) を落とさずに数える。
- **対戦中note率**: `phase=battle` の決断ターンで操作指示を返せなかった空振り。
- **劣位技選択**: move助言のうち、概算最大打点の50%未満しか出ない技を選んだターン。

### 判定モデルのルーブリック採点 (各1-5点)

- `tactics` 戦術妥当性 (ダメージ効率、行動順、勝ち筋)
- `safety` リスク管理 (被弾、温存、持ち物ケア、交代判断)
- `consistency` 整合性 (判明済みの技・特性・持ち物・HP・相性と矛盾しないか)
- `verdict` 判定モデル自身の選択との相対評価 (better / equal / worse)

## 設計上の要点 (なぜこの形か)

1. **追認バイアス対策**: 判定モデルは審査対象の助言を読む前に「自分ならどう指すか」を先に決めさせる。ログ上の実選択やマスターの反応は判定モデルに見せない。「自分と違う」だけでは減点しないことを明示する。
2. **ブランチ比較の公平性**: 判定モデルへ渡す盤面コンテキストは、候補生成パイプライン (`battleWorkflow.ts`) を通さず `scripts/eval-advice.ts` 内の安定した実装だけで作る。評価対象コードの改善が判定材料そのものを豊かにして採点を汚染する、という循環を断つため。
3. **幻覚ガード**: 判定モデルには「自分側の技は列挙されたものだけ」「相手の非公開情報を断定しない」を厳守させる (初期スモークで、判定モデルが手持ちに無い技を前提に減点する事例を確認して追加した)。

## ベースライン

`reports/eval/baseline-logged.json` — 実対戦で出荷された助言63件の採点。不変条件違反20ターンは、`sanitizeSpeechForVoice` (%リーク) と phase巻き戻りガードの**導入前に記録された過去バグの痕跡**であり、現行コードでは再現しない (liveベースラインで確認)。

`reports/eval/baseline-live.json` — 改修前コードで同じ63ターンを再生した採点 (総合4.11)。

`reports/eval/pitch1-live.json` — 両面ターン評価の初版。総合3.82へ劣化し、原因2つ (トリックルーム無視の行動順注記、交代先の被弾データ欠如) をこの計測で特定・修正した。測定器が設計欠陥を実際に検出した記録として残す。

`reports/eval/pitch12-live.json` — 修正版 + 構造化FieldState (総合3.99、整合はベースライン同等、劣位技選択は同数)。総合の残差-0.12は judge のばらつき (±0.1程度) と近接しており、以後の改善はこのレポートとの `--compare` で判断する。

## 注意

- liveモードとjudge採点は実際にOpenAI APIを呼ぶ (料金と時間がかかる)。`--limit` で母集団を絞れる。
- 判定スコアは絶対値ではなく**同一judge設定・同一母集団での相対比較**にのみ使う。judgeモデルを変えたら過去レポートと比較しない。
