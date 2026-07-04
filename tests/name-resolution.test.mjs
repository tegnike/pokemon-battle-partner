import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDataStore } from "../src/mastra/localData.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = createLocalDataStore(path.resolve(__dirname, "..", "data", "champions"));

// 音声入力・LLM抽出で技名が漢字表記になるケース。かな表記と同じidに解決されること。
const kanjiMovePairs = [
  ["地震", "じしん"],
  ["炎の牙", "ほのおのキバ"],
  ["竜の爪", "ドラゴンクロー"],
  ["竜の舞", "りゅうのまい"],
  ["岩石封じ", "がんせきふうじ"],
  ["波動弾", "はどうだん"],
  ["不意打ち", "ふいうち"],
  ["鉄壁", "てっぺき"],
  ["羽休め", "はねやすめ"],
  ["剣の舞", "つるぎのまい"],
  ["流星群", "りゅうせいぐん"],
  ["吹雪", "ふぶき"],
  ["冷凍パンチ", "れいとうパンチ"],
  ["悪の波動", "あくのはどう"],
  // かなと漢字が混在した部分表記(例: りゅうの + 舞)。
  ["りゅうの舞", "りゅうのまい"],
  ["りゅうの爪", "ドラゴンクロー"],
  // カタカナと漢字が混在した表記(カタカナ畳み込み + 漢字別名の両方が要る)。
  ["トンボ返り", "とんぼがえり"]
];
for (const [kanji, kana] of kanjiMovePairs) {
  const kanaId = store.resolveMoveId(kana);
  assert.ok(kanaId, `kana form should resolve: ${kana}`);
  assert.equal(store.resolveMoveId(kanji), kanaId, `kanji form should resolve to same move: ${kanji} == ${kana}`);
}

// カタカナ⇄ひらがなの表記ゆれ。音声認識が「なまける」を「ナマケル」と返しても解決すること。
assert.equal(store.resolveMoveId("ナマケル"), store.resolveMoveId("なまける"), "katakana rendering should fold to hiragana");
assert.ok(store.resolveMoveId("ナマケル"), "ナマケル should resolve to slackoff");

// メガ進化が存在しない種名に「メガ」が付いても、ベース種へフォールバックして解決すること。
assert.equal(store.resolvePokemonId("メガスターミー"), store.resolvePokemonId("スターミー"), "nonexistent mega falls back to base");
assert.ok(store.resolvePokemonId("メガスターミー"), "メガスターミー should resolve to starmie");

// 実在するメガ進化は従来どおりメガidへ解決されること(フォールバックで壊さない)。
assert.equal(store.resolvePokemonId("メガメタグロス"), "metagrossmega", "real mega resolves to mega id");
assert.equal(store.resolvePokemonId("メガギャラドス"), "gyaradosmega", "real mega resolves to mega id");
assert.equal(store.resolvePokemonId("メタグロス"), "metagross", "base form still resolves to base id");

console.log("name resolution tests passed");
