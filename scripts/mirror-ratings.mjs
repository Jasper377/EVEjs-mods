#!/usr/bin/env node
/**
 * 备门镜像：把 ping.5318.cm 上**已签名**的快照抄进 docs/ratings/。
 *
 * 为什么要它：启动器读快照走「多镜像 + 本地缓存 + 验签」。主门 ping.5318.cm 出问题时
 * （Workers 故障、证书、D1/KV 抖动），第二地址就是这里：
 *   https://diguo520.github.io/EVEjs-mods/ratings/ratings.json
 *   https://diguo520.github.io/EVEjs-mods/ratings/sponsors.json
 *   https://diguo520.github.io/EVEjs-mods/ratings/reviews/<modId>.json
 *
 * 三条硬规矩：
 *   1. **先验签再落盘**：签名对不上、keyId 不是预期那把，就原样保留旧文件、非 0 退出，
 *      绝不让一份改过的名单进镜像（坏镜像比没有镜像更糟）。
 *   2. 拉不到就什么都不做（不删旧文件、不写空文件）：主门抖一下不该把备门掏空。
 *   3. 只碰 docs/ratings/ 下面这几种形状，别的地方一概不写。
 *
 * 用法：
 *   node scripts/mirror-ratings.mjs                     # 线上 → docs/ratings
 *   MIRROR_SOURCE=http://127.0.0.1:8787 node scripts/mirror-ratings.mjs
 *   node scripts/mirror-ratings.mjs --out /tmp/ratings  # 只出产物，不碰仓库
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const BASE = (process.env.MIRROR_SOURCE || "https://ping.5318.cm").replace(/\/+$/, "");
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT_DIR = path.resolve(argValue("--out", path.join(ROOT, "docs", "ratings")));
const TIMEOUT_MS = Number(process.env.MIRROR_TIMEOUT_MS || 20000);
const ATTEMPTS = 3;

/**
 * 主门那把服务快照专用密钥的**公钥**，与启动器内置的是同一把：
 *   src-tauri/src/mods/ratings.rs 的 RATINGS_KEY_ID / RATINGS_PUBKEY
 * 换钥匙时两边一起改，镜像这里改完还得把 docs/ratings/ 重新生成一遍。
 */
const EXPECTED_KEY_ID = "evejs-ratings-2026-10-01";
const EXPECTED_PUBKEY = "6MxPBqHTbNgFk0sdBcNebLjgnEehk0wvrkYAZGpV7u0=";

/** Ed25519 裸 32 字节公钥 → SPKI，交给 node:crypto 验签 */
function publicKeyObject(rawBase64) {
  const raw = Buffer.from(rawBase64.trim(), "base64");
  if (raw.length !== 32) throw new Error("公钥必须是 32 字节 base64（Ed25519 raw）");
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

/** 与 infra/src/canonical.js 的 canonicalJson 一致：摘掉 signature，递归按 key 升序，紧凑序列化 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(doc) {
  const { signature: _omit, ...rest } = doc;
  return JSON.stringify(sortKeysDeep(rest));
}

const PUBLIC_KEY = publicKeyObject(EXPECTED_PUBKEY);

/** 验签：形状、keyId、Ed25519 三道全过才算数 */
function verifyDoc(doc, label) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(label + "：不是对象");
  if (doc.schemaVersion !== 1) throw new Error(label + "：schemaVersion 不是 1");
  const signature = doc.signature;
  if (!signature || signature.alg !== "ed25519" || typeof signature.sig !== "string") {
    throw new Error(label + "：没有可用的 signature");
  }
  if (signature.keyId !== EXPECTED_KEY_ID) {
    throw new Error(label + "：keyId 是 " + signature.keyId + "，预期 " + EXPECTED_KEY_ID);
  }
  const ok = crypto.verify(
    null,
    Buffer.from(canonicalJson(doc), "utf8"),
    PUBLIC_KEY,
    Buffer.from(signature.sig, "base64")
  );
  if (!ok) throw new Error(label + "：验签不通过（内容被动过或换过钥匙）");
}

async function fetchJson(url, label) {
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "evejs-mods-mirror" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const doc = await response.json();
      verifyDoc(doc, label);
      return doc;
    } catch (error) {
      last = error?.message || String(error);
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(label + " 取不到：" + last);
}

/** 模组 id 白名单：与 infra 的 shardPath 同口径，id 要进 URL 路径 */
function safeModId(modId) {
  const id = String(modId ?? "").trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : "";
}

const stats = { written: 0, same: 0, pruned: 0 };

function writeDoc(relative, doc) {
  const target = path.join(OUT_DIR, relative);
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === text) {
    stats.same += 1;
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  stats.written += 1;
}

async function main() {
  const ratings = await fetchJson(BASE + "/v1/ratings.json", "ratings.json");
  const sponsors = await fetchJson(BASE + "/v1/sponsors.json", "sponsors.json");

  const mods = ratings.mods && typeof ratings.mods === "object" ? ratings.mods : {};
  const modIds = Object.keys(mods).map(safeModId).filter(Boolean).sort();

  const shards = [];
  for (const modId of modIds) {
    shards.push([modId, await fetchJson(BASE + "/v1/reviews/" + modId + ".json", "reviews/" + modId + ".json")]);
  }

  // 全部拉齐并且全验过签，才开始落盘 —— 中途失败时上面已经崩了，不会写半份
  writeDoc("ratings.json", ratings);
  writeDoc("sponsors.json", sponsors);
  for (const [modId, doc] of shards) writeDoc(path.join("reviews", modId + ".json"), doc);

  // 线上已经没有的模组，镜像里的旧分片要删掉，否则启动器可能读到早就撤回干净的评论
  const reviewsDir = path.join(OUT_DIR, "reviews");
  const keep = new Set(shards.map(([modId]) => modId + ".json"));
  if (fs.existsSync(reviewsDir)) {
    for (const name of fs.readdirSync(reviewsDir)) {
      if (!name.endsWith(".json") || keep.has(name)) continue;
      fs.rmSync(path.join(reviewsDir, name));
      stats.pruned += 1;
    }
  }

  console.log(
    "镜像完成：" + OUT_DIR + "\n" +
      "  来源 " + BASE + "（keyId " + EXPECTED_KEY_ID + "，逐份验签通过）\n" +
      "  ratings.json：" + Object.keys(mods).length + " 个模组的聚合分\n" +
      "  sponsors.json：" + (sponsors.sponsors?.length ?? 0) + " 位赞助人\n" +
      "  reviews/：" + shards.length + " 份分片\n" +
      "  新写 " + stats.written + " 份 / 未变 " + stats.same + " 份 / 清掉 " + stats.pruned + " 份"
  );
}

main().catch((error) => {
  console.error("镜像失败，仓库里的旧文件原样保留：" + (error?.message || error));
  process.exit(1);
});
