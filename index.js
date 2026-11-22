/**
 * dsh-session-cleanup — Host half.
 *
 * DSH 没有「删除会话」功能，只有归档；归档只改一个 id 数组，日志一个字节都不动。
 * 这个插件补上真正的删除，并且**不需要退出应用**：
 *
 *   · 注册表（workspace.json）走官方 API：ctx.workspaceRegistry 的
 *     unarchiveSession / detachSession 都是 durable 写入，会触发 domain/changed，
 *     侧栏 feed 实时刷新。手改 JSON 那套（Cmd+Q + 覆盖内存状态）整个不需要了。
 *   · 文件层自己动手：rename 到 <DSH_HOME>/trash/dsh-session-cleanup/<时间戳>/，
 *     同卷 rename 是原子的，不产生一次全量拷贝；保留 N 天可还原，N 之后才真删。
 *   · 孤儿目录（磁盘有、注册表无）和孤儿投影缓存直接清，它们本来就不会显示。
 *
 * 为什么删除必须同时动注册表和文件：
 *   侧栏的行 = live 会话 ∪ 持久化 listing，workspace.json 的 sessionIds 只决定
 *   「归到哪个工作区」。只 detach 不删文件 → 行会掉进「未分组」还在侧栏；
 *   只删文件不改注册表 → 留下点开报 session/not-found 的空行。
 *
 * 安全边界：
 *   · live 会话一律拒绝，不做「自动停掉再删」。
 *   · 只 rename 不 rm；真删只发生在 empty-trash 且必须显式点名时间戳。
 *   · 不碰 profiles / settings / 凭据 / session_projcache.json 旧整包文件。
 *   · 不注册 agent tool、不写 systemPrompt —— 运行期 0 token。
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Loader 诊断用的插件名。 */
export const name = 'session-cleanup'

/** 需要的服务：HTTP 路由、会话存储、工作区注册表、会话持久化。 */
export const inject = ['webServer', 'sessions', 'workspaceRegistry', 'sessionPersistence']

/** 默认保留天数：回收站里的东西 7 天后才允许真删。 */
const DEFAULT_RETENTION_DAYS = 7

/** 一次请求体上限：这里只接受 id 数组，1 MiB 足够。 */
const BODY_LIMIT = 1024 * 1024

/** 路由前缀。 */
const ROUTE = '/api/dsh-session-cleanup'

/** 回收站目录名（在 <DSH_HOME>/trash/ 下）。 */
const TRASH_DIR_NAME = 'dsh-session-cleanup'

/**
 * 插件配置。
 * @typedef {{ retentionDays?: number }} Config
 */

/**
 * 插件入口。
 * @param {any} ctx - Host context。
 * @param {Config} config - 行配置。
 */
export function apply(ctx, config = {}) {
  const retentionDays = normalizeRetention(config.retentionDays)
  const home = resolveHome(ctx)
  const sessionsRoot = path.join(home, 'sessions')
  const trashRoot = path.join(home, 'trash', TRASH_DIR_NAME)
  const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions')

  /** 串行化所有变更操作：两个删除请求不能交错改注册表。 */
  let tail = Promise.resolve()
  /**
   * 排队执行一个变更操作。
   * @param {() => Promise<any>} operation - 变更体。
   * @returns {Promise<any>} 操作结果。
   */
  const exclusive = (operation) => {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 盘点当前状态。
   * @returns {Promise<any>} 快照。
   */
  const inventory = async () => {
    const workspaces = ctx.workspaceRegistry.list()
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String))
    const live = new Set(ctx.sessions.list().map((session) => String(session.id)))

    /** @type {Map<string, any>} */
    const byId = new Map()
    /** 内存里还驻留、但日志已经不存在的会话：已经删过，不该再出现在列表里。 */
    const deletedGhosts = new Set()
    let snapshots = []
    try {
      snapshots = await ctx.sessionPersistence.list()
    } catch (error) {
      ctx.logger.warn(`session-cleanup: sessionPersistence.list() failed: ${String(error)}`)
    }
    for (const snapshot of snapshots) {
      const id = String(snapshot.header.id)
      byId.set(id, {
        id,
        header: snapshot.header,
        createdAt: snapshot.header.createdAt ?? null,
        cwd: snapshot.header.cwd ?? null,
        bytes: snapshot.sizeBytes ?? 0,
        logPath: snapshot.location?.path ?? null,
        formatStatus: snapshot.formatStatus ?? null,
      })
    }

    // live 但持久化里没有的会话：两种可能，必须分开。
    //   · 新建后还没落盘 —— 正常，列出来但不可删；
    //   · 我们刚删过，日志已进回收站，只是 Host 内存里还留着这个 Session
    //     对象（api-session/removed 只清 Client 缓存，不驱逐 Host 的会话）。
    //     这种必须排除，否则删完的会话会一直躺在列表里，看起来像没删掉。
    for (const session of ctx.sessions.list()) {
      const id = String(session.id)
      if (byId.has(id)) continue
      if (await hasLogDir(home, session)) {
        // 日志还在，只是持久化 listing 没列到：当普通会话处理。
        byId.set(id, {
          id,
          header: session.header ?? null,
          createdAt: session.header?.createdAt ?? null,
          cwd: session.header?.cwd ?? null,
          bytes: 0,
          logPath: null,
          formatStatus: null,
        })
        continue
      }
      // 内存残留且日志不在 = 已经删掉了，不再算作现存会话。
      deletedGhosts.add(id)
    }

    const ownerOf = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        ownerOf.set(String(sessionId), workspace)
      }
    }

    const sessions = []
    for (const record of byId.values()) {
      // 已删除的内存残留不参与列表：日志已经在回收站里了。
      if (deletedGhosts.has(record.id)) continue
      const workspace = ownerOf.get(record.id)
      const isLive = live.has(record.id)
      const title = titleOf(ctx, record)
      // 对所有会话都问一次：有定时任务挂在会话上时，它不一定处于 live 状态，
      // 但删掉会让那个任务失去归属。UI 与执行路径用同一个判定，避免「显示可删、点了却失败」。
      const activity = await activityOf(ctx, record.id)
      // 注意：DSH 的 live 只是「驻留在内存」，归档也不会驱逐它，所以驻留本身不代表
      // 正在工作。真正的判据是有没有运行中的轮次 / 子代理 / 后台任务 / 定时任务。
      // 只看 live 会让几乎所有会话都不可删（打开过的会话一直驻留）。
      const busy = activity.length > 0
      const blocked = busy
        ? 'busy'
        : record.logPath === null && !isLive
          ? 'no-log'
          : null
      sessions.push({
        ...record,
        title,
        workspaceId: workspace === undefined ? null : String(workspace.id),
        workspaceTitle: workspace === undefined ? null : workspace.title,
        workspacePath: workspace === undefined ? null : workspace.path,
        archived: archived.has(record.id),
        live: isLive,
        activity: activity.map((entry) => String(entry.kind ?? 'unknown')),
        deletable: blocked === null,
        blocked,
        cacheBytes: await sizeOf(path.join(cacheRoot, `${record.id}.json`)),
      })
    }
    sessions.sort(compareSessions)

    const orphans = []
    const known = new Set(byId.keys())
    for (const entry of await listDir(sessionsRoot)) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(sessionsRoot, entry.name)
      for (const child of await listDir(projectDir)) {
        if (!child.isDirectory()) continue
        const id = child.name
        if (known.has(id)) continue
        const dir = path.join(projectDir, id)
        orphans.push({
          id,
          dir,
          projectDir: entry.name,
          bytes: await sizeOf(dir),
          cacheBytes: await sizeOf(path.join(cacheRoot, `${id}.json`)),
          cachePath: (await exists(path.join(cacheRoot, `${id}.json`)))
            ? path.join(cacheRoot, `${id}.json`)
            : null,
        })
      }
    }
    orphans.sort((left, right) => right.bytes - left.bytes)

    const orphanCaches = []
    for (const entry of await listDir(cacheRoot)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (known.has(id)) continue
      if (orphans.some((orphan) => orphan.id === id)) continue
      const file = path.join(cacheRoot, entry.name)
      orphanCaches.push({ id, path: file, bytes: await sizeOf(file) })
    }
    orphanCaches.sort((left, right) => right.bytes - left.bytes)

    const trash = await readTrash(trashRoot, retentionDays)

    const sessionBytes = sessions.reduce((total, item) => total + item.bytes, 0)
    const sessionCacheBytes = sessions.reduce((total, item) => total + item.cacheBytes, 0)
    const orphanBytes = orphans.reduce((total, item) => total + item.bytes + item.cacheBytes, 0)
    const orphanCacheBytes = orphanCaches.reduce((total, item) => total + item.bytes, 0)
    const trashBytes = trash.reduce((total, item) => total + item.bytes, 0)

    return {
      ok: true,
      home,
      retentionDays,
      sessions,
      orphans,
      orphanCaches,
      trash,
      totals: {
        sessionBytes,
        sessionCacheBytes,
        orphanBytes,
        orphanCacheBytes,
        trashBytes,
        reclaimable: orphanBytes + orphanCacheBytes,
      },
    }
  }

  /**
   * 删除一组会话（注册表 + 文件一起动）。
   * @param {string[]} ids - 会话 id。
   * @returns {Promise<any>} 逐条结果。
   */
  const deleteSessions = async (ids) => {
    const results = []
    const stage = await allocateStage(trashRoot)
    const stamp = path.basename(stage)
    const manifest = { stamp, createdAt: new Date().toISOString(), entries: [] }

    for (const rawId of ids) {
      const id = String(rawId)
      try {
        // 只拦「真的在工作」的会话。驻留内存本身不是拒绝理由：DSH 从不驱逐
        // 打开过的会话，按驻留拒绝会让这个插件几乎删不掉任何东西。
        // 判据必须和 inventory 完全一致，否则会出现「显示可删、点了失败」。
        const activity = await activityOf(ctx, id)
        if (activity.length > 0) {
          results.push({ id, ok: false, code: 'busy', activity: activity.map((entry) => String(entry.kind)) })
          continue
        }
        const snapshot = await ctx.sessionPersistence.stat(id)
        if (snapshot === undefined) {
          results.push({ id, ok: false, code: 'not-found' })
          continue
        }
        const logPath = snapshot?.location?.path ?? null
        const owner = workspaceOf(ctx, id)
        const entry = {
          id,
          title: snapshot === undefined
            ? null
            : titleOf(ctx, { id, header: snapshot.header, cwd: snapshot.header.cwd ?? null }),
          cwd: snapshot?.header?.cwd ?? null,
          createdAt: snapshot?.header?.createdAt ?? null,
          workspaceId: owner === undefined ? null : String(owner.id),
          workspacePath: owner === undefined ? null : owner.path,
          logDir: logPath === null ? null : path.dirname(logPath),
          bytes: snapshot?.sizeBytes ?? 0,
          cachePath: null,
        }

        // 1) 备份清单先落盘：后面任何一步失败，还原都靠它。
        await fsp.mkdir(stage, { recursive: true, mode: 0o700 })
        const cacheFile = path.join(cacheRoot, `${id}.json`)
        if (await exists(cacheFile)) entry.cachePath = cacheFile
        manifest.entries.push(entry)
        await writeManifest(stage, manifest)

        // 2) 注册表：先取消归档，再从工作区解绑。走官方 API，durable 且实时广播。
        if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) {
          await ctx.workspaceRegistry.unarchiveSession(id)
        }
        for (const workspace of ctx.workspaceRegistry.list()) {
          if (!workspace.sessionIds.includes(id)) continue
          await workspace.detachSession(id)
        }

        // 3) 文件：同卷 rename 进回收站。原子、瞬时、不拷贝。
        let moved = false
        if (entry.logDir !== null && await exists(entry.logDir)) {
          await fsp.mkdir(stage, { recursive: true, mode: 0o700 })
          await moveDir(entry.logDir, path.join(stage, id))
          moved = true
        }

        // 4) 投影缓存：派生数据，删失败只警告，不影响结论。
        if (entry.cachePath !== null) {
          try {
            await fsp.rm(entry.cachePath, { force: true })
          } catch (error) {
            ctx.logger.warn(`session-cleanup: could not remove projection cache for ${id}: ${String(error)}`)
          }
        }

        // 5) 通知客户端：立刻丢行，不必等下一次列表刷新。
        try {
          ctx.emit('api-session/removed', id)
        } catch (error) {
          ctx.logger.warn(`session-cleanup: api-session/removed dispatch failed: ${String(error)}`)
        }

        results.push({ id, ok: true, moved, bytes: entry.bytes, stamp })
      } catch (error) {
        results.push({ id, ok: false, code: 'failed', message: String(error && error.message ? error.message : error) })
      }
    }

    if (manifest.entries.length === 0) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    }
    return { ok: true, stamp, results }
  }

  /**
   * 清理孤儿：磁盘上有、注册表里没有的日志目录，以及没有对应日志的投影缓存。
   * @returns {Promise<any>} 逐条结果。
   */
  const sweepOrphans = async () => {
    const snapshot = await inventory()
    const results = []
    const stage = await allocateStage(trashRoot)
    const stamp = path.basename(stage)
    const manifest = { stamp, createdAt: new Date().toISOString(), entries: [] }

    for (const orphan of snapshot.orphans) {
      try {
        await fsp.mkdir(stage, { recursive: true, mode: 0o700 })
        manifest.entries.push({
          id: orphan.id,
          title: null,
          cwd: null,
          createdAt: null,
          workspaceId: null,
          workspacePath: null,
          logDir: orphan.dir,
          bytes: orphan.bytes,
          cachePath: orphan.cachePath,
          orphan: true,
        })
        await writeManifest(stage, manifest)
        await moveDir(orphan.dir, path.join(stage, orphan.id))
        if (orphan.cachePath !== null) {
          await fsp.rm(orphan.cachePath, { force: true }).catch(() => {})
        }
        results.push({ id: orphan.id, ok: true, bytes: orphan.bytes })
      } catch (error) {
        results.push({ id: orphan.id, ok: false, code: 'failed', message: String(error) })
      }
    }

    // 孤儿缓存：没有日志目录也没有注册表记录，直接删文件（派生数据，无需备份）。
    for (const cache of snapshot.orphanCaches) {
      try {
        await fsp.rm(cache.path, { force: true })
        results.push({ id: cache.id, ok: true, bytes: cache.bytes, cacheOnly: true })
      } catch (error) {
        results.push({ id: cache.id, ok: false, code: 'failed', message: String(error) })
      }
    }

    if (manifest.entries.length === 0) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    }
    return { ok: true, stamp, results }
  }

  /**
   * 从回收站还原。
   * @param {string[]} ids - 会话 id。
   * @returns {Promise<any>} 逐条结果。
   */
  const restore = async (ids) => {
    const wanted = new Set(ids.map(String))
    const results = []
    for (const entry of await listDir(trashRoot)) {
      if (!entry.isDirectory()) continue
      const stage = path.join(trashRoot, entry.name)
      let manifest
      try {
        manifest = JSON.parse(await fsp.readFile(path.join(stage, 'manifest.json'), 'utf8'))
      } catch {
        continue
      }
      for (const record of manifest.entries ?? []) {
        if (!wanted.has(String(record.id))) continue
        const id = String(record.id)
        try {
          const moved = path.join(stage, id)
          if (record.logDir !== null && await exists(moved)) {
            await fsp.mkdir(path.dirname(record.logDir), { recursive: true, mode: 0o700 })
            await moveDir(moved, record.logDir)
          }
          if (record.workspaceId !== null) {
            const workspace = ctx.workspaceRegistry.get(record.workspaceId)
            if (workspace !== undefined) {
              try {
                await workspace.attachSession(id)
              } catch (error) {
                // cwd 目录已不存在时 attach 会拒绝：会话会落到「未分组」，不算失败。
                ctx.logger.warn(`session-cleanup: restored ${id} but could not re-attach to its workspace: ${String(error)}`)
              }
            }
          }
          manifest.entries = manifest.entries.filter((item) => String(item.id) !== id)
          await writeManifest(stage, manifest)
          results.push({ id, ok: true })
          wanted.delete(id)
        } catch (error) {
          results.push({ id, ok: false, code: 'failed', message: String(error) })
        }
      }
      if ((manifest.entries ?? []).length === 0) {
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
      }
    }
    for (const id of wanted) {
      results.push({ id, ok: false, code: 'not-found' })
    }
    return { ok: true, results }
  }

  /**
   * 永久清空回收站。只接受点名的时间戳，且必须已过保留期。
   * @param {string[]} stamps - 时间戳目录名。
   * @returns {Promise<any>} 逐条结果。
   */
  const emptyTrash = async (stamps) => {
    const results = []
    for (const stamp of stamps.map(String)) {
      // 目录名是 <时间戳> 或 <时间戳>-<序号>（同一秒内的多次操作）。
      if (!/^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(stamp)) {
        results.push({ stamp, ok: false, code: 'bad-stamp' })
        continue
      }
      const stage = path.join(trashRoot, stamp)
      if (!isInside(trashRoot, stage)) {
        results.push({ stamp, ok: false, code: 'bad-stamp' })
        continue
      }
      if (!(await exists(stage))) {
        results.push({ stamp, ok: false, code: 'not-found' })
        continue
      }
      try {
        const info = await statOf(stage)
        const ageDays = (Date.now() - info.mtimeMs) / 86_400_000
        if (ageDays < retentionDays) {
          results.push({ stamp, ok: false, code: 'too-young', remainingDays: Math.ceil(retentionDays - ageDays) })
          continue
        }
        const bytes = await sizeOf(stage)
        await fsp.rm(stage, { recursive: true, force: true })
        results.push({ stamp, ok: true, bytes })
      } catch (error) {
        results.push({ stamp, ok: false, code: 'failed', message: String(error) })
      }
    }
    return { ok: true, results }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const method = url.pathname.startsWith(`${ROUTE}/`) ? url.pathname.slice(ROUTE.length + 1) : ''
      try {
        if (method === 'inventory') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
            return
          }
          sendJson(res, 200, await inventory())
          return
        }
        if (!acceptPost(req, res)) return
        const body = await readJsonBody(req)
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []
        const stamps = Array.isArray(body.stamps) ? body.stamps.map(String).filter(Boolean) : []
        if (method === 'delete') {
          if (ids.length === 0) {
            sendJson(res, 400, { ok: false, code: 'empty' })
            return
          }
          sendJson(res, 200, await exclusive(() => deleteSessions(ids)))
          return
        }
        if (method === 'sweep') {
          sendJson(res, 200, await exclusive(sweepOrphans))
          return
        }
        if (method === 'restore') {
          if (ids.length === 0) {
            sendJson(res, 400, { ok: false, code: 'empty' })
            return
          }
          sendJson(res, 200, await exclusive(() => restore(ids)))
          return
        }
        if (method === 'empty-trash') {
          if (stamps.length === 0) {
            sendJson(res, 400, { ok: false, code: 'empty' })
            return
          }
          sendJson(res, 200, await exclusive(() => emptyTrash(stamps)))
          return
        }
        sendJson(res, 404, { ok: false, code: 'unknown-method' })
      } catch (error) {
        ctx.logger.warn(`session-cleanup: ${method || 'route'} failed: ${String(error)}`)
        sendJson(res, 500, { ok: false, code: 'failed', message: String(error && error.message ? error.message : error) })
      }
    },
  }), 'dsh-session-cleanup: /api/dsh-session-cleanup')

  // 启动时清一次过期的回收站：保留期外的目录由用户手动点「清空」，这里只清理
  // 「manifest 已经空了但目录还在」的残骸，避免空目录堆积。
  ctx.effect(() => {
    void (async () => {
      for (const entry of await listDir(trashRoot)) {
        if (!entry.isDirectory()) continue
        const stage = path.join(trashRoot, entry.name)
        try {
          const manifest = JSON.parse(await fsp.readFile(path.join(stage, 'manifest.json'), 'utf8'))
          if ((manifest.entries ?? []).length === 0) {
            await fsp.rm(stage, { recursive: true, force: true })
          }
        } catch {
          // 没有 manifest 的目录不认识，不动它。
        }
      }
    })().catch((error) => {
      ctx.logger.warn(`session-cleanup: trash housekeeping failed: ${String(error)}`)
    })
    return () => {}
  }, 'dsh-session-cleanup: trash housekeeping')
}

/* ------------------------------------------------------------------ 工具 */

/**
 * 规范化保留天数。
 * @param {unknown} value - 配置值。
 * @returns {number} 非负整数天。
 */
function normalizeRetention(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return DEFAULT_RETENTION_DAYS
  return Math.floor(number)
}

/**
 * 解析 DSH 数据根目录：优先用宿主提供的 dshHomePath，其次 $DSH_HOME，最后 ~/.dsh。
 * @param {any} ctx - Host context。
 * @returns {string} 绝对路径。
 */
function resolveHome(ctx) {
  try {
    const helper = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof helper === 'function') return helper()
  } catch {
    // 没有这个服务就退回环境变量。
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * 读会话标题：优先投影缓存的 title 行，其次 cwd 末段。
 * @param {any} ctx - Host context。
 * @param {{ id: string, header?: any, cwd: string | null }} record - 会话记录。
 * @returns {string} 展示用标题。
 */
function titleOf(ctx, record) {
  const header = record.header
  try {
    const cache = typeof ctx.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
    // cachedSnapshot 用 header 的 lifecycle 字段做身份校验，缺字段会直接返回 undefined，
    // 所以有完整 header 时才查缓存，否则退回目录名。
    if (header && typeof header.version === 'number' && typeof header.createdAt === 'number'
      && cache !== undefined && typeof cache.cachedSnapshot === 'function') {
      const snapshot = cache.cachedSnapshot(header, ['title'])
      const title = snapshot?.values?.title
      if (typeof title === 'string' && title.trim() !== '') return title
    }
  } catch {
    // 缓存不可用就退回目录名。
  }
  if (typeof record.cwd === 'string' && record.cwd !== '') {
    const base = path.basename(record.cwd)
    if (base !== '') return base
  }
  return record.id
}

/**
 * 问组合里的提供者：这个会话还有没有在跑的东西。
 * @param {any} ctx - Host context。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<any[]>} 活动列表。
 */
async function activityOf(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    return await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  } catch (error) {
    // 判定失败时保守当成「有活动」，宁可不删。
    return [{ kind: 'unknown' }]
  }
}

/**
 * 判断一个 live Session 的日志是否还在磁盘上。
 *
 * 删除会话后，Host 内存里的 Session 对象不会立刻消失（`api-session/removed`
 * 只清 Client 缓存），所以 `ctx.sessions.list()` 仍会返回它。这类残留如果照常
 * 列出，删完的会话会一直躺在页面上，看起来像没删掉。用日志目录是否存在来区分
 * 「新建未落盘」和「已删除的内存残留」。
 * @param {string} home - DSH 数据根。
 * @param {any} session - live Session。
 * @returns {Promise<boolean>} 日志目录是否还在。
 */
async function hasLogDir(home, session) {
  const id = String(session.id)
  for (const entry of await listDir(path.join(home, 'sessions'))) {
    if (!entry.isDirectory()) continue
    if (await exists(path.join(home, 'sessions', entry.name, id))) return true
  }
  return false
}

/**
 * 找到某个会话所属的工作区。
 * @param {any} ctx - Host context。
 * @param {string} sessionId - 会话 id。
 * @returns {any} 工作区实体或 undefined。
 */
function workspaceOf(ctx, sessionId) {
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (workspace.sessionIds.includes(sessionId)) return workspace
  }
  return undefined
}

/**
 * 列表排序：先可删的、再按占用降序。
 * @param {any} left - 左。
 * @param {any} right - 右。
 * @returns {number} 比较结果。
 */
function compareSessions(left, right) {
  if (left.deletable !== right.deletable) return left.deletable ? -1 : 1
  if (right.bytes !== left.bytes) return right.bytes - left.bytes
  return String(left.title).localeCompare(String(right.title))
}

/**
 * 时间戳目录名。
 * @returns {string} YYYYMMDD-HHmmss。
 */
function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * 分配一个独占的回收站目录。
 *
 * 时间戳只到秒，同一秒里的两次操作（删会话紧接着清孤儿）会撞名，后一次把
 * 前一次的 manifest 覆盖掉，前一批就再也还原不了。所以创建目录用非递归的
 * mkdir：已存在就换下一个后缀重试，天然原子。
 * @param {string} trashRoot - 回收站根。
 * @returns {Promise<string>} 已创建的目录绝对路径。
 */
async function allocateStage(trashRoot) {
  const base = timestamp()
  await fsp.mkdir(trashRoot, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = path.join(trashRoot, attempt === 0 ? base : `${base}-${attempt}`)
    try {
      await fsp.mkdir(candidate, { mode: 0o700 })
      return candidate
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`could not allocate a recycle-bin directory under ${trashRoot}`)
}

/**
 * 写清单（整体覆盖，先写临时文件再 rename，避免半截 JSON）。
 * @param {string} stage - 回收站时间戳目录。
 * @param {any} manifest - 清单内容。
 * @returns {Promise<void>} 完成。
 */
async function writeManifest(stage, manifest) {
  const file = path.join(stage, 'manifest.json')
  const temp = `${file}.tmp`
  await fsp.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await fsp.rename(temp, file)
}

/**
 * 读回收站。
 * @param {string} trashRoot - 回收站根。
 * @param {number} retentionDays - 保留天数。
 * @returns {Promise<any[]>} 每个时间戳一条。
 */
async function readTrash(trashRoot, retentionDays) {
  const out = []
  for (const entry of await listDir(trashRoot)) {
    if (!entry.isDirectory()) continue
    const stage = path.join(trashRoot, entry.name)
    let manifest
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(stage, 'manifest.json'), 'utf8'))
    } catch {
      continue
    }
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    if (entries.length === 0) continue
    const info = await statOf(stage).catch(() => undefined)
    const createdAt = info === undefined ? Date.now() : info.mtimeMs
    const ageDays = (Date.now() - createdAt) / 86_400_000
    out.push({
      stamp: entry.name,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : new Date(createdAt).toISOString(),
      bytes: entries.reduce((total, item) => total + (Number(item.bytes) || 0), 0),
      purgeable: ageDays >= retentionDays,
      remainingDays: Math.max(0, Math.ceil(retentionDays - ageDays)),
      entries: entries.map((item) => ({
        id: String(item.id),
        title: item.title ?? null,
        workspacePath: item.workspacePath ?? null,
        bytes: Number(item.bytes) || 0,
        orphan: item.orphan === true,
      })),
    })
  }
  out.sort((left, right) => String(right.stamp).localeCompare(String(left.stamp)))
  return out
}

/**
 * 移动目录：同卷 rename，跨卷退化成 copy + rm。
 * @param {string} from - 源。
 * @param {string} to - 目标。
 * @returns {Promise<void>} 完成。
 */
async function moveDir(from, to) {
  try {
    await fsp.rename(from, to)
    return
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fsp.cp(from, to, { recursive: true, force: true, preserveTimestamps: true })
      await fsp.rm(from, { recursive: true, force: true })
      return
    }
    throw error
  }
}

/**
 * 目录项列表，目录不存在时返回空数组。
 * @param {string} dir - 目录。
 * @returns {Promise<import('node:fs').Dirent[]>} 目录项。
 */
async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * 路径是否存在。
 * @param {string} target - 路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function exists(target) {
  try {
    await fsp.lstat(target)
    return true
  } catch {
    return false
  }
}

/**
 * 读 stat，失败返回 undefined。
 * @param {string} target - 路径。
 * @returns {Promise<import('node:fs').Stats | undefined>} stat。
 */
async function statOf(target) {
  try {
    return await fsp.stat(target)
  } catch {
    return undefined
  }
}

/**
 * 文件或目录占用字节数；文件直接 stat，目录递归求和。
 * @param {string} target - 路径。
 * @returns {Promise<number>} 字节数。
 */
async function sizeOf(target) {
  let info
  try {
    info = await fsp.stat(target)
  } catch {
    return 0
  }
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let total = 0
  for (const entry of await listDir(target)) {
    total += await sizeOf(path.join(target, entry.name))
  }
  return total
}

/**
 * 目标是否落在根目录内（防止路径穿越写错地方）。
 * @param {string} root - 根。
 * @param {string} target - 目标。
 * @returns {boolean} 是否在内部。
 */
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * 同源检查：浏览器同源带 Sec-Fetch-Site，老浏览器看 Origin 的 host。
 * 两个都没有（脚本、curl）放行——那不是网页发的。
 * @param {any} req - 请求。
 * @returns {boolean} 是否同源。
 */
function sameOriginRequest(req) {
  const headers = (req && req.headers) || {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '') return site === 'same-origin' || site === 'none'
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === String(headers.host || '')
  } catch {
    return false
  }
}

/**
 * POST 的公共检查：方法、同源、JSON。
 * @param {any} req - 请求。
 * @param {any} res - 响应。
 * @returns {boolean} 是否放行。
 */
function acceptPost(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
    return false
  }
  if (!sameOriginRequest(req)) {
    sendJson(res, 403, { ok: false, code: 'cross-origin' })
    return false
  }
  const type = req.headers ? req.headers['content-type'] : ''
  if (!/^application\/json\s*(;|$)/i.test(String(type || ''))) {
    sendJson(res, 415, { ok: false, code: 'json-only' })
    return false
  }
  return true
}

/**
 * 读 JSON 请求体。
 * @param {any} req - 请求。
 * @returns {Promise<any>} 解析结果。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * 写 JSON 响应。
 * @param {any} res - 响应。
 * @param {number} status - 状态码。
 * @param {any} payload - 载荷。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}
