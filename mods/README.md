# `mods/` —— 版本记录（一次发布一条 PR 的落点）

这个目录里的每个 `<id>.json` 是**一个模组当前被合并的版本记录**，由启动器的
「提交模组 → 3) 提交审核」自动开 PR 写入，维护者合并后才生效。

```json
{
  "schemaVersion": 1,
  "id": "evejs-example",
  "source": "owner/evejs-mod-evejs-example",
  "displayName": "Example",
  "version": "1.0.2",
  "sha256": "<64 位 hex>",
  "sizeBytes": 12345,
  "downloadUrls": [{ "mirror": "github", "priority": 1, "url": "https://github.com/.../v1.0.2/evejs-example-1.0.2.zip" }],
  "author": { "id": "au-xxxx", "keyId": "xxxxxxxxxxxx", "name": "作者" },
  "publishedAt": "2026-09-28",
  "submittedAt": "2026-09-28T02:11:31Z"
}
```

- `id` 必须与作者仓库根目录 `evejs-mod.json` 里的 `id` 一致，且 `source` 必须与
  `sources.json` 里登记的那一行一致，否则构建时整条来源会被跳过并打印原因。
- 其余元数据（简介 / readme / 标签 / 分类 / 兼容版本…）不在这里重复，构建时仍然从
  作者仓库的 `evejs-mod.json` 现抓。
- 构建时 `mods/<id>.json` 会**覆盖**清单里的 `version` / `sha256` / `sizeBytes` /
  `downloadUrls` / `publishedAt` —— 这就是「合并之后市场才换版本」的实现方式。
- 同一模组的新版本会更新同一个文件（启动器复用 `release/<id>` 分支），所以这里不会堆积历史版本。

---

# `mods/` — version records (where "one PR per release" lands)

Each `<id>.json` is the **merged version record** of one mod. It is opened as a PR by the launcher
(**Submit mod -> 3) Submit for review**) and only takes effect after the maintainer merges it.

`build-index.mjs` uses the merged record as the authoritative version of that source
(`version` / `sha256` / `sizeBytes` / `downloadUrls` / `publishedAt` override the author's
`evejs-mod.json`); everything else still comes from the author's own listing. A record whose
`source` does not match the registered `sources.json` entry makes the whole source be skipped
and reported. New versions update the same file, so this directory never accumulates history.
