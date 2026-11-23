# awesome-dsh-plugin 收录材料

## 1. 条目文件（唯一必需的东西）

**路径**：`data/plugins/FelixRaySun__dsh-session-cleanup.yml`

文件名规则：`<owner>__<repo>.yml`，owner 与 repo 用**两个下划线**连接。

```yaml
url: https://github.com/FelixRaySun/dsh-session-cleanup
name: FelixRaySun/dsh-session-cleanup
category: session
description:
  en: Deletes sessions for real and keeps them restorable — detaches the registry through the official API, moves the log into a 7-day recycle bin with an atomic rename, and sweeps orphan log directories and projection caches.
  zh: 真正删除会话且可还原——通过官方 API 解绑注册表，把日志原子移动到保留 7 天的回收站，并清理孤儿日志目录与孤儿投影缓存。
icon: https://raw.githubusercontent.com/FelixRaySun/dsh-session-cleanup/main/assets/icon-360.png
```

## 2. 格式要点（都对照过 contributing.md）

| 项 | 规则 | 本条目 |
|---|---|---|
| 文件名 | `<owner>__<repo>.yml` | `FelixRaySun__dsh-session-cleanup.yml` ✅ |
| `url` | 必须与仓库**完全一致** | 用 `FelixRaySun`，不是旧名 `MrSunml`（后者 301 重定向）✅ |
| `name` | 列表里显示的链接文字 | `FelixRaySun/dsh-session-cleanup` ✅ |
| `category` | 见合法取值表 | `session` ✅ |
| `description.en` | **唯一必填项**，以句号结尾，不能有营销词 | ✅ |
| `description.zh` | 可选，维护者会补 | 已提供 ✅ |
| 含 `: ` 需加引号 | YAML 会误判为嵌套键 | 本条目不含 `: `，无需引号 ✅ |
| `icon` | GitHub 托管的位图（png/jpg/webp），方形最佳，~96px 显示 | `assets/icon-360.png`，360×360 方形 PNG ✅ |

`category` 合法取值：
`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`

## 3. 提交前必须完成的事

### 3.1 上传新增文件到你的仓库

条目里引用的图标目前还是 404，**必须先上传**，否则市场卡片取不到图：

| 文件 | 状态 |
|---|---|
| `assets/icon-360.png` | ⬜ 待上传 |
| `screenshots.json` | ⬜ 待上传 |
| `docs/images/trash-and-orphans.jpg` | ⬜ 待上传 |
| `README.md`（作者改为 FelixSun） | ⬜ 待更新 |
| `LICENSE`（Copyright 2026 FelixSun） | ⬜ 待更新 |
| `package.json`（author: FelixSun） | ⬜ 待更新 |

`screenshots.json` 内容（放在 `package.json` 旁边）：

```json
[
  "docs/images/overview.jpg",
  "docs/images/trash-and-orphans.jpg"
]
```

市场详情页会按这个顺序展示 App Store 风格截图。不声明也能自动从 README 抽取，但声明后你能控制顺序。

### 3.2 给仓库加 topic

```bash
# GitHub 网页：仓库首页 → About 右侧齿轮 → Topics 添加 dsh-plugin
```

收录要求里有明确一条：**Add the `dsh-plugin` topic to your repo.**

### 3.3 仓库年龄

要求创建满 **1 天**，由 CI 自动检查。你的仓库 11-22 创建，已满足。

## 4. 提 PR

```bash
# fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
git clone https://github.com/FelixRaySun/awesome-dsh-plugin
cd awesome-dsh-plugin

# 新建条目文件
mkdir -p data/plugins
# 把第 1 节的 YAML 存成 data/plugins/FelixRaySun__dsh-session-cleanup.yml

git checkout -b add-dsh-session-cleanup
git add data/plugins/FelixRaySun__dsh-session-cleanup.yml
git commit -m "Add FelixRaySun/dsh-session-cleanup"
git push origin add-dsh-session-cleanup
```

PR 标题：`Add FelixRaySun/dsh-session-cleanup`

**注意**：不要手工编辑 `README.md`。那两个 README 由 `data/plugins/*.yml` 生成，合并后会在 `main` 上自动重新生成。

## 5. PR 描述

````markdown
Adds `FelixRaySun/dsh-session-cleanup` under **session**.

**What it does.** DSH only archives sessions — archiving appends an id to `archivedSessionIds` and leaves every log byte on disk. This plugin adds the missing disk layer and keeps the result recoverable:

- a sidebar page lists every session with its log size, projection-cache size and owning workspace;
- deleting detaches the registry through the official API (`ctx.workspaceRegistry.unarchiveSession` / `detachSession`, both durable and live-broadcast) instead of hand-editing `workspace.json`, so no restart is needed;
- the log moves into a 7-day recycle bin with an atomic same-volume `rename`, and restores from the same page;
- it also sweeps orphan log directories (on disk, absent from the registry) and orphan projection caches.

**Manifest.** Declares `dsh.bundle.patch` and ships a `cordis.patch.yml`; the client half adds the sidebar launcher and page. Installs with:

```sh
dsh plugin --profile desktop add github:FelixRaySun/dsh-session-cleanup
```

No build step, no dependencies, pure ESM.

**Not on npm.** The npm name `dsh-session-cleanup` is already taken by an unrelated package (`hyein-cbio/dsh-session-cleanup`), so this one is GitHub-only. It installs from source as shown above.

**Deletability rule.** The plugin refuses a session only while `ctx.waterfall('workspace/session-activity')` reports a running turn, subagent, job or schedule — not while the session is merely resident in memory. DSH never evicts an opened session (archiving does not either), so a `live` check would refuse nearly everything; on a test profile all four historical sessions reported `live: true`.

**Testing.** Exercised on DSH `0.2.2-rc.5` / macOS against real data: orphan cache sweep (8 → 0, 768 KB → 500 KB), a real delete (log into the recycle bin, session gone from `workspace.json`), restore (log back in place, workspace re-attached), byte-identical restore (30,694 bytes before and after), and the retention guard (`empty-trash` returns `too-young` inside 7 days).

**Distinct from similarly named entries already listed:**

| Plugin | Scope | Recycle bin |
|---|---|---|
| `2026heshao/dsh-forget-session` | single session, row menu | no |
| `LucasCaleb-ggg/dsh-session-cleanup` | batch by workspace | no |
| `Donglin027/dsh-session-cleanup` | orphan attachments / caches / ledger | yes, with journal |
| `MrKillerBad/dsh-session-delete` | single session, row menu | no |
| **this one** | single + batch + orphans, full page | **yes, restorable in-page** |

License: Apache-2.0.
````

## 6. 审核可能问到的问题

**为什么和已有同名插件不同？**
见描述里的对照表。核心差异是回收站与页面还原，另外几个直接删或只清孤儿。

**为什么 npm 上没有？**
名字被 `hyein-cbio/dsh-session-cleanup` 占用（无关项目）。列表接受 GitHub-only 条目，安装命令已在描述里给出。

**为什么不用 `live` 判定可删性？**
DSH 的 `ctx.sessions.list()` 长期驻留所有打开过的会话，归档也不驱逐。实测 4 个历史会话全部 `live: true`。改用 activity waterfall 判定真实运行状态。

**安全问题？**
HTTP 路由做同源校验，POST 只接受 JSON；不碰 `profiles`、凭据、附件库；只 rename 不 rm，真删需显式点名批次且必须过保留期。

## 7. 账号名变更提醒

`MrSunml` 已 301 重定向到 `FelixRaySun`。条目、图标 URL、安装命令、README 作者链接全部使用新名 `FelixRaySun`。

旧名在 GitHub 上仍会重定向，但条目规则要求 `url` 与仓库完全一致，用旧名有被打回的风险。
