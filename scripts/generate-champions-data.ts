import { Dex } from "@pkmn/dex";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const outDir = path.resolve("data/champions");
const dex = Dex.forGen(9);

const japaneseAliases: Record<string, string[]> = {
  garchomp: ["ガブリアス"],
  "garchompmega": ["メガガブリアス"],
  primarina: ["アシレーヌ"],
  metagross: ["メタグロス"],
  "metagrossmega": ["メガメタグロス"],
  rotomwash: ["ウォッシュロトム", "水ロトム", "ミトム"],
  meowscarada: ["マスカーニャ"],
  hydreigon: ["サザンドラ"],
  dragonite: ["カイリュー"],
  mimikyu: ["ミミッキュ"],
  archaludon: ["ブリジュラス", "ブリジラス"],
  swampert: ["ラグラージ"],
  "swampertmega": ["メガラグラージ"],
  raichu: ["ライチュウ"],
  "raichualola": ["アローラライチュウ"],
  raichumegax: ["メガライチュウX", "メガライチューX"],
  raichumegay: ["メガライチュウY", "メガライチューY"],
  charizard: ["リザードン"],
  gyarados: ["ギャラドス"],
  "gyaradosmega": ["メガギャラドス"],
  basculegion: ["イダイトウ", "イダイトウ(オス)", "イダイトウ（オス）"],
  delphox: ["マフォクシー"],
  glimmora: ["キラフロル"],
  grimmsnarl: ["オーロンゲ"],
  gholdengo: ["サーフゴー"],
  mawile: ["クチート"],
  "mawilemega": ["メガクチート"],
  skeledirge: ["ラウドボーン"],
  kingambit: ["ドドゲザン"],
  aegislash: ["ギルガルド"],
  scizor: ["ハッサム"],
  "scizormega": ["メガハッサム"],
  samurotthisui: ["ヒスイダイケンキ"],
  ceruledge: ["ソウブレイズ"],
  volcarona: ["ウルガモス"],
  starmie: ["スターミー"],
  vanilluxe: ["バイバニラ"],
  umbreon: ["ブラッキー"],
  meganium: ["メガニウム"],
  venusaur: ["フシギバナ"],
  "venusaurmega": ["メガフシギバナ"],
  sneasler: ["オオニューラ"],
  blastoise: ["カメックス"],
  "blastoisemega": ["メガカメックス"],
  lucario: ["ルカリオ"],
  "lucariomega": ["メガルカリオ"],
  sylveon: ["ニンフィア"],
  mamoswine: ["マンムー"],
  whimsicott: ["エルフーン"],
  rotomheat: ["ヒートロトム", "火ロトム"],
  corviknight: ["アーマーガア"],
  tinglu: ["ディンルー"],
  annihilape: ["コノヨザル"],
  dragapult: ["ドラパルト"],
  hippowdon: ["カバルドン"],
  pelipper: ["ペリッパー"],
  stunfisk: ["マッギョ"],
  gengar: ["ゲンガー"],
  blaziken: ["バシャーモ"],
  "blazikenmega": ["メガバシャーモ"],
  lopunny: ["ミミロップ"],
  "lopunnymega": ["メガミミロップ"],
  ninetalesalola: ["アローラキュウコン"],
  bellibolt: ["ハラバリー", "ハラバリ", "アラバリ"],
  staraptor: ["ムクホーク"],
  "staraptormega": ["メガムクホーク"],
  froslass: ["ユキメノコ"],
  greninja: ["ゲッコウガ"],
  chandelure: ["シャンデラ"],
  dragalge: ["ドラミドロ"],
  leafeon: ["リーフィア"],
  fluttermane: ["ハバタクカミ"]
};

const manualMoveAliases: Record<string, string[]> = {
  earthquake: ["じしん"],
  dragonclaw: ["ドラゴンクロー"],
  rocktomb: ["がんせきふうじ"],
  icywind: ["こごえるかぜ", "凍える風"],
  bulldoze: ["じならし"],
  electroweb: ["エレキネット"],
  stealthrock: ["ステルスロック"],
  sparklingaria: ["うたかたのアリア"],
  moonblast: ["ムーンフォース"],
  icebeam: ["れいとうビーム"],
  energyball: ["エナジーボール"],
  ironhead: ["アイアンヘッド"],
  bulletpunch: ["バレットパンチ"],
  hammerarm: ["アームハンマー"],
  thunderpunch: ["かみなりパンチ"],
  hydropump: ["ハイドロポンプ"],
  thunderbolt: ["10まんボルト", "10万ボルト"],
  willowisp: ["おにび"],
  voltswitch: ["ボルトチェンジ"],
  flowertrick: ["トリックフラワー"],
  knockoff: ["はたきおとす"],
  tripleaxel: ["トリプルアクセル"],
  suckerpunch: ["ふいうち"],
  dracometeor: ["りゅうせいぐん"],
  leafstorm: ["リーフストーム"],
  closecombat: ["インファイト"],
  flamecharge: ["ニトロチャージ"],
  darkpulse: ["あくのはどう"],
  flamethrower: ["かえんほうしゃ"],
  earthpower: ["だいちのちから"]
};

const abilityAliases: Record<string, string[]> = {
  roughskin: ["さめはだ"],
  torrent: ["げきりゅう"],
  clearbody: ["クリアボディ"],
  toughclaws: ["かたいツメ"],
  levitate: ["ふゆう"],
  protean: ["へんげんじざい"]
};

const itemAliases: Record<string, string[]> = {
  focussash: ["きあいのタスキ"],
  expertbelt: ["たつじんのおび"],
  metagrossite: ["メタグロスナイト"],
  leftovers: ["たべのこし"],
  lifeorb: ["いのちのたま"],
  choicescarf: ["こだわりスカーフ"]
};

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, file), `${JSON.stringify(data, null, 2)}\n`);
}

interface MoveAvailabilityFile {
  source: {
    name: string;
    url: string;
    revisionId: number | null;
    revisionTimestamp: string | null;
    fetchedAt: string;
  };
  counts: {
    uniqueMoves: number;
    usable: number;
    unusable: number;
  };
  moves: Record<string, boolean>;
}

interface MoveJaAliasesFile {
  source: {
    name: string;
    url: string;
    assetUrl: string;
    fetchedAt: string;
  };
  counts: {
    resolvedMoves: number;
    aliases: number;
  };
  moves: Record<string, string[]>;
}

function readMoveAvailability(): MoveAvailabilityFile | null {
  const file = path.join(outDir, "move-availability.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as MoveAvailabilityFile;
}

function readMoveJaAliases(): MoveJaAliasesFile | null {
  const file = path.join(outDir, "move-ja-aliases.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as MoveJaAliasesFile;
}

function mergeAliasTables(...tables: Array<Record<string, string[]> | undefined>): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const table of tables) {
    for (const [id, aliases] of Object.entries(table ?? {})) {
      merged[id] ??= [];
      for (const alias of aliases) {
        if (!merged[id].includes(alias)) merged[id].push(alias);
      }
    }
  }
  return merged;
}

const moveAvailability = readMoveAvailability();
const importedMoveJaAliases = readMoveJaAliases();
const moveAliases = mergeAliasTables(importedMoveJaAliases?.moves, manualMoveAliases);

const pokemon = dex.species
  .all()
  .filter((species) => species.exists && species.num > 0)
  .map((species) => ({
    id: species.id,
    num: species.num,
    name: species.name,
    baseSpecies: species.baseSpecies,
    forme: species.forme || "",
    types: species.types,
    baseStats: species.baseStats,
    abilities: species.abilities,
    weightkg: species.weightkg,
    isMega: Boolean(species.isMega),
    isNonstandard: species.isNonstandard ?? null,
    aliasesJa: japaneseAliases[species.id] ?? []
  }))
  .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));

const moves = dex.moves
  .all()
  .filter((move) => move.exists && move.num > 0)
  .map((move) => {
    const usableInChampions = moveAvailability?.moves[move.id] ?? null;
    return {
      id: move.id,
      num: move.num,
      name: move.name,
      type: move.type,
      category: move.category,
      basePower: move.basePower,
      accuracy: move.accuracy,
      pp: move.pp,
      priority: move.priority,
      target: move.target,
      flags: move.flags,
      secondary: move.secondary ?? null,
      secondaries: move.secondaries ?? null,
      boosts: move.boosts ?? null,
      self: move.self ?? null,
      status: move.status ?? null,
      volatileStatus: move.volatileStatus ?? null,
      forceSwitch: move.forceSwitch ?? null,
      selfSwitch: move.selfSwitch ?? null,
      heal: move.heal ?? null,
      drain: move.drain ?? null,
      recoil: move.recoil ?? null,
      isNonstandard: move.isNonstandard ?? null,
      usableInChampions,
      championsAvailabilitySource: usableInChampions === null ? null : moveAvailability?.source.name ?? null,
      aliasesJa: moveAliases[move.id] ?? []
    };
  })
  .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));

const abilities = dex.abilities
  .all()
  .filter((ability) => ability.exists && ability.num > 0)
  .map((ability) => ({
    id: ability.id,
    num: ability.num,
    name: ability.name,
    shortDesc: ability.shortDesc,
    isNonstandard: ability.isNonstandard ?? null,
    aliasesJa: abilityAliases[ability.id] ?? []
  }))
  .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));

const items = dex.items
  .all()
  .filter((item) => item.exists && item.num > 0)
  .map((item) => ({
    id: item.id,
    num: item.num,
    name: item.name,
    shortDesc: item.shortDesc,
    fling: item.fling ?? null,
    isBerry: Boolean(item.isBerry),
    isNonstandard: item.isNonstandard ?? null,
    aliasesJa: itemAliases[item.id] ?? []
  }))
  .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));

const natures = dex.natures.all().map((nature) => ({
  id: nature.id,
  name: nature.name,
  plus: nature.plus ?? null,
  minus: nature.minus ?? null
}));

const aliases = {
  pokemon: japaneseAliases,
  moves: moveAliases,
  abilities: abilityAliases,
  items: itemAliases
};

writeJson("metadata.json", {
  generatedAt: new Date().toISOString(),
  game: "Pokemon Champions",
  source: {
    dex: "@pkmn/dex",
    dexVersion: require("@pkmn/dex/package.json").version,
    dataVersion: require("@pkmn/data/package.json").version,
    generation: 9,
    moveAvailability: moveAvailability
      ? {
          name: moveAvailability.source.name,
          url: moveAvailability.source.url,
          revisionId: moveAvailability.source.revisionId,
          revisionTimestamp: moveAvailability.source.revisionTimestamp,
          fetchedAt: moveAvailability.source.fetchedAt
        }
      : null,
    moveJaAliases: importedMoveJaAliases
      ? {
          name: importedMoveJaAliases.source.name,
          url: importedMoveJaAliases.source.url,
          assetUrl: importedMoveJaAliases.source.assetUrl,
          fetchedAt: importedMoveJaAliases.source.fetchedAt
        }
      : null
  },
  championsRules: {
    level: 50,
    ivs: "abolished; calculated as fixed 31",
    statPoints: {
      perStatMax: 32,
      totalMax: 66
    },
    statFormula: {
      hp: "floor((base * 2 + 31 + statPoints * 2) * 50 / 100) + 60",
      other:
        "floor((floor((base * 2 + 31 + statPoints * 2) * 50 / 100) + 5) * natureModifier)"
    }
  },
  counts: {
    pokemon: pokemon.length,
    moves: moves.length,
    championsUsableMoves: moves.filter((move) => move.usableInChampions === true).length,
    championsUnusableMoves: moves.filter((move) => move.usableInChampions === false).length,
    championsUnknownMoves: moves.filter((move) => move.usableInChampions === null).length,
    moveJaAliases: Object.values(moveAliases).reduce((sum, aliases) => sum + aliases.length, 0),
    abilities: abilities.length,
    items: items.length,
    natures: natures.length
  }
});
writeJson("pokemon.json", pokemon);
writeJson("moves.json", moves);
writeJson("abilities.json", abilities);
writeJson("items.json", items);
writeJson("natures.json", natures);
writeJson("ja-aliases.json", aliases);

console.log(`Generated Champions local data in ${outDir}`);
