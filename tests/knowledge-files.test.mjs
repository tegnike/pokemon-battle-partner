import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const knowledgeDir = path.resolve("data/knowledge/pokemon");
const requiredSections = [
  "## 基本メモ",
  "## よく見る技",
  "## よく見る持ち物",
  "## 特性傾向",
  "## 性格と能力ポイント傾向",
  "## 同じチームに入りやすいポケモン",
  "## 対戦での見方",
  "## 参照元",
  "## 扱い",
];
const requiredSources = [
  "https://gamewith.jp/pokemon-champions/555373",
  "https://game8.jp/pokemon-champions/779317",
];

const files = (await readdir(knowledgeDir))
  .filter((file) => file.endsWith(".md"))
  .sort();

assert.equal(files.length, 50, "expected 50 Pokemon knowledge files");

for (const file of files) {
  const filePath = path.join(knowledgeDir, file);
  const text = await readFile(filePath, "utf8");
  const lines = text.trimEnd().split("\n");

  assert.ok(lines.length >= 30, `${file} should have at least 30 lines`);
  assert.match(text, /^# .+/m, `${file} should start with a Pokemon heading`);
  assert.doesNotMatch(text, /[ \t]$/m, `${file} should not contain trailing whitespace`);

  for (const section of requiredSections) {
    assert.ok(text.includes(section), `${file} is missing ${section}`);
  }
  for (const source of requiredSources) {
    assert.ok(text.includes(source), `${file} is missing source ${source}`);
  }
}

console.log(`Validated ${files.length} Pokemon knowledge files.`);
