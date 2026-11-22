/**
 * dsh-session-cleanup — 浏览器半区。
 *
 * 左侧图标栏加一个「会话清理」入口，主区渲染清理页：
 *   页头（总量 / 可回收 / 刷新）· 会话表（勾选、大小、工作区、状态、删除）
 *   · 孤儿日志目录 · 孤儿投影缓存 · 回收站（还原 / 清空）。
 *
 * 所有数据只有一个来源：宿主的 GET /api/dsh-session-cleanup/inventory。
 * 这里不做任何判断，只把宿主算好的 deletable / blocked / purgeable 渲染出来。
 * 颜色全部取自宿主主题 token，浅色深色都能用。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-cleanup',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useCallback = React.useCallback
    const useRef = React.useRef
    const useLayoutEffect = React.useLayoutEffect || React.useEffect

    const NS = 'dsh-session-cleanup'
    const PANEL_ID = 'session-cleanup'
    const STYLE_ID = 'dsh-session-cleanup-style'
    const BASE = '/api/dsh-session-cleanup'

    /* -------------------------------------------------------------- 文案 */

    const EN = {
      'panel.title': 'Session cleanup',
      'page.title': 'Session cleanup',
      'page.subtitle': 'Delete sessions for real. The registry is detached through the official API, and the log moves to a recycle bin instead of being erased.',
      'action.refresh': 'Refresh',
      'action.reload': 'Reload',
      'action.delete': 'Delete selected',
      'action.sweep': 'Clean orphans',
      'action.restore': 'Restore',
      'action.purge': 'Delete permanently',
      'action.cancel': 'Cancel',
      'action.confirm': 'Delete',
      'stat.sessions': 'Sessions',
      'stat.sessionBytes': 'Log size',
      'stat.cacheBytes': 'Projection cache',
      'stat.reclaimable': 'Reclaimable now',
      'stat.trash': 'In recycle bin',
      'section.sessions': 'Sessions',
      'section.orphans': 'Orphan log directories',
      'section.orphanCaches': 'Orphan projection caches',
      'section.trash': 'Recycle bin',
      'empty.sessions': 'No sessions.',
      'empty.orphans': 'No orphan log directories.',
      'empty.orphanCaches': 'No orphan projection caches.',
      'empty.trash': 'The recycle bin is empty.',
      'hint.orphans': 'On disk, absent from the registry: they never appear in the sidebar, so removing them cannot leave a broken row.',
      'hint.orphanCaches': 'Derived data with no matching log. A stale cache only costs a longer replay, never a wrong value.',
      'hint.trash': 'Deleted sessions stay here until the retention window passes. Restoring puts the log back and re-attaches the workspace.',
      'hint.live': 'Running a turn, a subagent, or a background job. Stop it or delete from another session.',
      'hint.resident': 'Still loaded in memory, but not working. Deleting is safe; DSH drops it on the next write.',
      'hint.noLog': 'No stored log yet.',
      'col.title': 'Title',
      'col.workspace': 'Workspace',
      'col.size': 'Size',
      'col.cache': 'Cache',
      'col.status': 'Status',
      'col.actions': 'Actions',
      'status.archived': 'Archived',
      'status.live': 'Live',
      'status.busy': 'Busy',
      'status.resident': 'Idle in memory',
      'status.ready': 'Ready',
      'status.orphan': 'Orphan',
      'confirm.title': 'Delete these sessions?',
      'confirm.body': 'The log moves to the recycle bin and the sidebar row disappears. You can restore it from this page for {days} days.',
      'confirm.live': 'Live sessions are excluded and will not be deleted.',
      'confirm.sweep': 'Clean every orphan directory and orphan cache?',
      'confirm.purge': 'Delete this batch permanently? This cannot be undone.',
      'result.deleted': 'Deleted {count} session(s), freed {size}.',
      'result.swept': 'Cleaned {count} item(s), freed {size}.',
      'result.restored': 'Restored {count} session(s).',
      'result.purged': 'Permanently deleted, freed {size}.',
      'result.none': 'Nothing to do.',
      'error.title': 'Something went wrong',
      'error.fetch': 'Could not reach the Host. Reload the page and try again.',
      'retention.days': 'Kept for {days} days',
      'retention.purgeable': 'Ready to purge',
      'retention.wait': '{days} day(s) left',
      'select.all': 'Select all',
      'unit.count': '{count}',
    }

    const ZH = {
      'panel.title': '会话清理',
      'page.title': '会话清理',
      'page.subtitle': '真正删除会话。注册表走官方 API 解绑，日志移到回收站而不是直接抹掉。',
      'action.refresh': '刷新',
      'action.reload': '重新加载',
      'action.delete': '删除所选',
      'action.sweep': '清理孤儿',
      'action.restore': '还原',
      'action.purge': '永久删除',
      'action.cancel': '取消',
      'action.confirm': '删除',
      'stat.sessions': '会话数',
      'stat.sessionBytes': '日志占用',
      'stat.cacheBytes': '投影缓存',
      'stat.reclaimable': '现在可回收',
      'stat.trash': '回收站',
      'section.sessions': '会话',
      'section.orphans': '孤儿日志目录',
      'section.orphanCaches': '孤儿投影缓存',
      'section.trash': '回收站',
      'empty.sessions': '没有会话。',
      'empty.orphans': '没有孤儿日志目录。',
      'empty.orphanCaches': '没有孤儿投影缓存。',
      'empty.trash': '回收站是空的。',
      'hint.orphans': '磁盘上有、注册表里没有：它们本来就不出现在侧栏，删掉不会留下报错的空行。',
      'hint.orphanCaches': '没有对应日志的派生数据。缓存过期只会让回放慢一点，不会算错。',
      'hint.trash': '删掉的会话先放在这里，过了保留期才允许永久删除。还原会把日志放回原位并重新挂回工作区。',
      'hint.live': '有运行中的轮次、子代理或后台任务。请先停止，或换一个会话操作。',
      'hint.resident': '还在内存里驻留，但没有在工作。可以删；下次写入时 DSH 会发现它已经不在。',
      'hint.noLog': '还没有落盘的日志。',
      'col.title': '标题',
      'col.workspace': '工作区',
      'col.size': '大小',
      'col.cache': '缓存',
      'col.status': '状态',
      'col.actions': '操作',
      'status.archived': '已归档',
      'status.live': '运行中',
      'status.busy': '有任务',
      'status.resident': '空闲驻留',
      'status.ready': '可删除',
      'status.orphan': '孤儿',
      'confirm.title': '删除这些会话？',
      'confirm.body': '日志会移到回收站，侧栏的行同时消失。{days} 天内可以在这个页面还原。',
      'confirm.live': '运行中的会话会被排除，不会删除。',
      'confirm.sweep': '清理所有孤儿目录和孤儿缓存？',
      'confirm.purge': '永久删除这一批？不可恢复。',
      'result.deleted': '已删除 {count} 个会话，释放 {size}。',
      'result.swept': '已清理 {count} 项，释放 {size}。',
      'result.restored': '已还原 {count} 个会话。',
      'result.purged': '已永久删除，释放 {size}。',
      'result.none': '没有可执行的操作。',
      'error.title': '出错了',
      'error.fetch': '连不上宿主。刷新页面再试一次。',
      'retention.days': '保留 {days} 天',
      'retention.purgeable': '可以永久删除',
      'retention.wait': '还剩 {days} 天',
      'select.all': '全选',
      'unit.count': '{count}',
    }

    /* -------------------------------------------------------- 文案绑定 */

    const localeBridge = {
      translate: null,
      localeId: '',
      listeners: new Set(),
      notify() {
        for (const listener of [...this.listeners]) {
          try {
            listener()
          } catch {
            // 某个订阅者抛错不该拖垮其他订阅者。
          }
        }
      },
    }

    function format(template, vars) {
      if (!vars) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key])))
    }

    function fallbackDict() {
      return String(localeBridge.localeId).toLowerCase().startsWith('zh') ? ZH : EN
    }

    function t(key, vars) {
      let text
      try {
        text = localeBridge.translate ? localeBridge.translate(key) : undefined
      } catch {
        text = undefined
      }
      if (!text || text === key) text = fallbackDict()[key] ?? key
      return format(text, vars)
    }

    function useLocaleRevision() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        const listener = () => setRevision((value) => value + 1)
        localeBridge.listeners.add(listener)
        return () => {
          localeBridge.listeners.delete(listener)
        }
      }, [])
      return null
    }

    /**
     * 绑定文案字典。
     * @param {any} ctx - Client context。
     * @returns {boolean} 是否绑定成功（失败时调用方可等 locale 服务就绪后重试）。
     */
    function attachLocale(ctx) {
      if (localeBridge.translate) return true
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      if (!locale) return false
      try {
        const snapshot = locale.getLocale ? locale.getLocale() : undefined
        const ids = new Set(['en', 'zh-CN'])
        if (snapshot && typeof snapshot.active === 'string') ids.add(snapshot.active)
        const languages = snapshot && Array.isArray(snapshot.locales) ? snapshot.locales : []
        for (const language of languages) {
          if (!language || typeof language.id !== 'string') continue
          if (language.id === 'en' || language.id.toLowerCase().startsWith('zh')) ids.add(language.id)
        }
        for (const id of ids) {
          const dict = id.toLowerCase().startsWith('zh') ? ZH : EN
          try {
            locale.register(NS, id, dict)
          } catch {
            // HMR 重载时同一份字典可能已注册，复用即可。
          }
        }
        localeBridge.translate = locale.bind(NS)
        if (snapshot && snapshot.active) localeBridge.localeId = snapshot.active
        if (typeof locale.subscribe === 'function') {
          locale.subscribe(() => {
            const next = locale.getLocale ? locale.getLocale() : undefined
            if (next && next.active) localeBridge.localeId = next.active
            localeBridge.notify()
          })
        }
        return true
      } catch (error) {
        // 绑定失败就退回内置字典，但要说清原因，否则只会表现为「界面是英文」。
        console.warn('[dsh-session-cleanup] binding the locale dictionaries failed:', error)
        return false
      }
    }

    /* ------------------------------------------------------------ 格式 */

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`
    }

    function formatCount(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
      return String(number)
    }

    /* -------------------------------------------------------------- 样式 */

    const CSS = `
.sc-root{
--sc-ink:var(--dsw-alias-label-primary);
--sc-muted:var(--dsw-alias-label-secondary);
--sc-faint:var(--dsw-alias-label-tertiary);
--sc-page:var(--dsw-alias-bg-base);
--sc-card:var(--dsw-alias-bg-layer-1);
--sc-line:var(--dsw-alias-border-l2);
--sc-hair:var(--dsw-alias-border-l1);
--sc-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));
--sc-danger:var(--dsw-alias-state-error-primary);
--sc-warn:var(--dsw-alias-state-warn-primary);
--sc-ok:var(--dsw-alias-state-success-primary);
--sc-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);
--sc-radius:14px;
height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;
background:var(--sc-page);color:var(--sc-ink);
font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
.sc-root *,.sc-root *::before,.sc-root *::after{box-sizing:border-box}
.sc-root button{font-family:inherit}
.sc-root :focus-visible{outline:2px solid var(--sc-accent);outline-offset:2px}
.sc-page{max-width:1120px;margin:0 auto;padding:28px 32px 64px;display:flex;flex-direction:column;gap:18px}
.sc-head{display:flex;align-items:flex-start;gap:16px;min-width:0}
.sc-titles{min-width:0;display:flex;flex-direction:column;gap:5px}
.sc-h1{font-size:20px;font-weight:650;line-height:1.15;letter-spacing:-.01em;margin:0}
.sc-sub{font-size:13px;color:var(--sc-muted);margin:0;max-width:70ch}
.sc-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.sc-btn{appearance:none;height:34px;display:inline-flex;align-items:center;gap:7px;padding:0 13px;border-radius:10px;border:1px solid var(--sc-line);background:var(--sc-card);color:var(--sc-ink);font-size:13px;font-weight:520;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.sc-btn:hover:not(:disabled){background:var(--sc-hover)}
.sc-btn:disabled{opacity:.45;cursor:not-allowed}
.sc-btn[data-variant="primary"]{background:var(--sc-accent);border-color:transparent;color:var(--sc-page);font-weight:600}
.sc-btn[data-variant="primary"]:hover:not(:disabled){filter:brightness(1.06);background:var(--sc-accent)}
.sc-btn[data-variant="danger"]{background:var(--sc-danger);border-color:transparent;color:var(--sc-page);font-weight:600}
.sc-btn[data-variant="danger"]:hover:not(:disabled){filter:brightness(1.06);background:var(--sc-danger)}
.sc-btn svg{width:15px;height:15px;display:block}
.sc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.sc-stat{border:1px solid var(--sc-hair);border-radius:12px;background:var(--sc-card);padding:12px 14px;display:flex;flex-direction:column;gap:3px;min-width:0}
.sc-stat-label{font-size:12px;color:var(--sc-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-stat-value{font-size:19px;font-weight:640;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.sc-section{border:1px solid var(--sc-hair);border-radius:var(--sc-radius);background:var(--sc-card);overflow:hidden}
.sc-section-head{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--sc-hair);min-width:0}
.sc-section-title{font-size:13px;font-weight:620;margin:0;white-space:nowrap}
.sc-section-count{font-size:12px;color:var(--sc-muted);font-variant-numeric:tabular-nums}
.sc-section-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.sc-hint{padding:10px 16px;font-size:12px;color:var(--sc-muted);border-bottom:1px solid var(--sc-hair);margin:0}
.sc-table{width:100%;border-collapse:collapse;table-layout:fixed}
.sc-table th,.sc-table td{padding:9px 12px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--sc-hair)}
.sc-table th{font-size:11.5px;font-weight:560;color:var(--sc-muted);text-transform:none;white-space:nowrap;background:transparent}
.sc-table tbody tr:last-child td{border-bottom:0}
.sc-table tbody tr:hover{background:var(--sc-hover)}
.sc-table td{font-size:13px}
.sc-cell-title{display:flex;flex-direction:column;gap:2px;min-width:0}
.sc-cell-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-cell-sub{font-size:11.5px;color:var(--sc-faint);font-variant-numeric:tabular-nums}
.sc-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.sc-check{width:16px;height:16px;accent-color:var(--sc-accent);cursor:pointer;margin:0}
.sc-check:disabled{cursor:not-allowed;opacity:.4}
.sc-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:540;white-space:nowrap;border:1px solid transparent}
.sc-tag[data-tone="ok"]{color:var(--sc-ok);background:color-mix(in srgb,var(--sc-ok) 12%,transparent)}
.sc-tag[data-tone="warn"]{color:var(--sc-warn);background:color-mix(in srgb,var(--sc-warn) 14%,transparent)}
.sc-tag[data-tone="danger"]{color:var(--sc-danger);background:color-mix(in srgb,var(--sc-danger) 12%,transparent)}
.sc-tag[data-tone="muted"]{color:var(--sc-muted);background:color-mix(in srgb,var(--sc-muted) 12%,transparent)}
.sc-tag[data-tone="accent"]{color:var(--sc-accent);background:color-mix(in srgb,var(--sc-accent) 12%,transparent)}
.sc-empty{padding:26px 16px;text-align:center;color:var(--sc-muted);font-size:13px}
.sc-list{display:flex;flex-direction:column}
.sc-row{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--sc-hair);min-width:0}
.sc-row:last-child{border-bottom:0}
.sc-row:hover{background:var(--sc-hover)}
.sc-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.sc-row-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.sc-row-sub{font-size:11.5px;color:var(--sc-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-row-side{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.sc-banner{border:1px solid var(--sc-line);border-radius:12px;padding:11px 14px;font-size:12.5px;display:flex;gap:9px;align-items:flex-start}
.sc-banner[data-tone="ok"]{border-color:color-mix(in srgb,var(--sc-ok) 40%,var(--sc-line));background:color-mix(in srgb,var(--sc-ok) 8%,transparent);color:var(--sc-ink)}
.sc-banner[data-tone="error"]{border-color:color-mix(in srgb,var(--sc-danger) 40%,var(--sc-line));background:color-mix(in srgb,var(--sc-danger) 8%,transparent);color:var(--sc-ink)}
.sc-mask{position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));padding:24px}
.sc-dialog{width:min(460px,100%);border-radius:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--sc-line);box-shadow:0 18px 48px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.28));padding:20px;display:flex;flex-direction:column;gap:12px}
.sc-dialog h2{margin:0;font-size:15px;font-weight:640}
.sc-dialog p{margin:0;font-size:13px;color:var(--sc-muted);line-height:1.5}
.sc-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.sc-spin{animation:sc-rot 1s linear infinite}
@keyframes sc-rot{to{transform:rotate(360deg)}}
.sc-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`

    function StyleTag() {
      useLayoutEffect(() => {
        if (typeof document === 'undefined' || !document.head) return
        let element = document.getElementById(STYLE_ID)
        if (!element) {
          element = document.createElement('style')
          element.id = STYLE_ID
          document.head.appendChild(element)
        }
        if (element.textContent !== CSS) element.textContent = CSS
      }, [])
      return null
    }

    /* -------------------------------------------------------------- 图标 */

    function CleanupIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9.5 7V5.2c0-.7.6-1.2 1.3-1.2h2.4c.7 0 1.3.5 1.3 1.2V7' }),
      h('path', { d: 'M6.4 7l.8 11.1c.05.8.7 1.4 1.5 1.4h6.6c.8 0 1.45-.6 1.5-1.4L17.6 7' }),
      h('path', { d: 'M10.4 10.6v5.4' }),
      h('path', { d: 'M13.6 10.6v5.4' }))
    }

    function RefreshIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M20 12a8 8 0 1 1-2.6-5.9' }),
      h('path', { d: 'M20 4.5V9h-4.5' }))
    }

    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9.5 7V5.2c0-.7.6-1.2 1.3-1.2h2.4c.7 0 1.3.5 1.3 1.2V7' }),
      h('path', { d: 'M6.4 7l.8 11.1c.05.8.7 1.4 1.5 1.4h6.6c.8 0 1.45-.6 1.5-1.4L17.6 7' }))
    }

    function UndoIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 12a8 8 0 1 0 2.6-5.9' }),
      h('path', { d: 'M4 4.5V9h4.5' }))
    }

    /* ------------------------------------------------------------ 数据层 */

    async function postJson(method, payload) {
      const response = await fetch(`${BASE}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        const code = data && data.code ? data.code : `http-${response.status}`
        const error = new Error(code)
        error.code = code
        error.data = data
        throw error
      }
      return data
    }

    /**
     * 拉盘点，并做一次静默重试：宿主刚装好插件时可能还没 ready。
     * @returns {Promise<any>} 快照。
     */
    async function fetchInventory() {
      const response = await fetch(`${BASE}/inventory`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`http-${response.status}`)
      const data = await response.json()
      if (!data || data.ok === false) throw new Error('bad-payload')
      return data
    }

    function useInventory() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const ticket = useRef(0)

      const load = useCallback(async () => {
        ticket.current += 1
        const mine = ticket.current
        setBusy(true)
        try {
          const next = await fetchInventory()
          if (mine === ticket.current) {
            setData(next)
            setError(null)
          }
        } catch (failure) {
          if (mine === ticket.current) setError(failure)
        } finally {
          if (mine === ticket.current) setBusy(false)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      return { data, error, busy, reload: load, setData }
    }

    /* ------------------------------------------------------------ 小组件 */

    function Stat(props) {
      return h('div', { className: 'sc-stat' },
        h('span', { className: 'sc-stat-label' }, props.label),
        h('span', { className: 'sc-stat-value' }, props.value))
    }

    function Section(props) {
      return h('section', { className: 'sc-section' },
        h('div', { className: 'sc-section-head' },
          h('h2', { className: 'sc-section-title' }, props.title),
          props.count !== undefined ? h('span', { className: 'sc-section-count' }, props.count) : null,
          props.actions ? h('div', { className: 'sc-section-actions' }, props.actions) : null),
        props.hint ? h('p', { className: 'sc-hint' }, props.hint) : null,
        props.children)
    }

    function Dialog(props) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.onCancel])

      return h('div', {
        className: 'sc-mask',
        role: 'presentation',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) props.onCancel()
        },
      },
      h('div', { className: 'sc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sc-dialog-title' },
        h('h2', { id: 'sc-dialog-title' }, props.title),
        ...props.lines.map((line, index) => h('p', { key: index }, line)),
        h('div', { className: 'sc-dialog-actions' },
          h('button', { type: 'button', className: 'sc-btn', onClick: props.onCancel }, t('action.cancel')),
          h('button', {
            type: 'button',
            className: 'sc-btn',
            'data-variant': props.danger ? 'danger' : 'primary',
            onClick: props.onConfirm,
          }, props.confirmLabel))))
    }

    function statusTag(session) {
      if (session.blocked === 'busy') {
        return h('span', { className: 'sc-tag', 'data-tone': 'warn', title: t('hint.live') }, t('status.busy'))
      }
      if (session.blocked === 'no-log') return h('span', { className: 'sc-tag', 'data-tone': 'muted' }, t('hint.noLog'))
      if (session.archived) return h('span', { className: 'sc-tag', 'data-tone': 'warn' }, t('status.archived'))
      if (session.live) {
        return h('span', { className: 'sc-tag', 'data-tone': 'accent', title: t('hint.resident') }, t('status.resident'))
      }
      return h('span', { className: 'sc-tag', 'data-tone': 'ok' }, t('status.ready'))
    }

    /* -------------------------------------------------------------- 页面 */

    function CleanupPage() {
      useLocaleRevision()
      const { data, error, busy, reload } = useInventory()
      const [selected, setSelected] = useState(() => new Set())
      const [dialog, setDialog] = useState(null)
      const [notice, setNotice] = useState(null)
      const [pending, setPending] = useState(false)

      const sessions = data ? data.sessions : []
      const orphans = data ? data.orphans : []
      const orphanCaches = data ? data.orphanCaches : []
      const trash = data ? data.trash : []
      const retentionDays = data ? data.retentionDays : 7

      // 选择集要跟着数据走：被删掉的行不该留在集合里。
      useEffect(() => {
        setSelected((current) => {
          const alive = new Set(sessions.filter((item) => item.deletable).map((item) => item.id))
          const next = new Set([...current].filter((id) => alive.has(id)))
          return next.size === current.size ? current : next
        })
      }, [sessions])

      const selectableIds = useMemo(
        () => sessions.filter((item) => item.deletable).map((item) => item.id),
        [sessions],
      )
      const allSelected = selectableIds.length > 0 && selected.size === selectableIds.length

      const toggle = useCallback((id) => {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const toggleAll = useCallback(() => {
        setSelected((current) => (current.size === selectableIds.length ? new Set() : new Set(selectableIds)))
      }, [selectableIds])

      const run = useCallback(async (task, describe) => {
        setPending(true)
        setNotice(null)
        try {
          const result = await task()
          setNotice({ tone: 'ok', text: describe(result) })
          setSelected(new Set())
          await reload()
        } catch (failure) {
          setNotice({ tone: 'error', text: failure && failure.code ? failure.code : String(failure) })
        } finally {
          setPending(false)
          setDialog(null)
        }
      }, [reload])

      const confirmDelete = useCallback(() => {
        const ids = [...selected]
        void run(
          () => postJson('delete', { ids }),
          (result) => {
            const done = (result.results ?? []).filter((item) => item.ok)
            if (done.length === 0) return t('result.none')
            const bytes = done.reduce((total, item) => total + (Number(item.bytes) || 0), 0)
            return t('result.deleted', { count: done.length, size: formatBytes(bytes) })
          },
        )
      }, [run, selected])

      const confirmSweep = useCallback(() => {
        void run(
          () => postJson('sweep', {}),
          (result) => {
            const done = (result.results ?? []).filter((item) => item.ok)
            if (done.length === 0) return t('result.none')
            const bytes = done.reduce((total, item) => total + (Number(item.bytes) || 0), 0)
            return t('result.swept', { count: done.length, size: formatBytes(bytes) })
          },
        )
      }, [run])

      const restoreStamp = useCallback((stamp, ids) => {
        void run(
          () => postJson('restore', { ids }),
          (result) => {
            const done = (result.results ?? []).filter((item) => item.ok)
            return t('result.restored', { count: done.length })
          },
        )
      }, [run])

      const purgeStamp = useCallback((stamp) => {
        void run(
          () => postJson('empty-trash', { stamps: [stamp] }),
          (result) => {
            const done = (result.results ?? []).filter((item) => item.ok)
            if (done.length === 0) return t('result.none')
            const bytes = done.reduce((total, item) => total + (Number(item.bytes) || 0), 0)
            return t('result.purged', { size: formatBytes(bytes) })
          },
        )
      }, [run])

      const totals = data ? data.totals : null

      return h('div', { className: 'sc-root' },
        h(StyleTag),
        h('div', { className: 'sc-page' },

          h('header', { className: 'sc-head' },
            h('div', { className: 'sc-titles' },
              h('h1', { className: 'sc-h1' }, t('page.title')),
              h('p', { className: 'sc-sub' }, t('page.subtitle'))),
            h('div', { className: 'sc-actions' },
              h('button', {
                type: 'button',
                className: 'sc-btn',
                onClick: () => void reload(),
                disabled: busy || pending,
              }, h('span', { className: busy ? 'sc-spin' : undefined, style: { display: 'inline-flex' } }, h(RefreshIcon)), t('action.refresh')))),

          notice ? h('div', { className: 'sc-banner', 'data-tone': notice.tone === 'ok' ? 'ok' : 'error' },
            h('span', null, notice.text),
            h('button', {
              type: 'button',
              className: 'sc-btn',
              style: { marginLeft: 'auto', height: 26, padding: '0 9px' },
              onClick: () => setNotice(null),
            }, '×')) : null,

          error && !data ? h('div', { className: 'sc-banner', 'data-tone': 'error' },
            h('span', null, `${t('error.title')}: ${t('error.fetch')}`)) : null,

          totals ? h('div', { className: 'sc-stats' },
            h(Stat, { label: t('stat.sessions'), value: formatCount(sessions.length) }),
            h(Stat, { label: t('stat.sessionBytes'), value: formatBytes(totals.sessionBytes) }),
            h(Stat, { label: t('stat.cacheBytes'), value: formatBytes(totals.sessionCacheBytes) }),
            h(Stat, { label: t('stat.reclaimable'), value: formatBytes(totals.reclaimable) }),
            h(Stat, { label: t('stat.trash'), value: formatBytes(totals.trashBytes) })) : null,

          h(Section, {
            title: t('section.sessions'),
            count: `${sessions.length}`,
            actions: [
              h('button', {
                key: 'del',
                type: 'button',
                className: 'sc-btn',
                'data-variant': 'danger',
                disabled: pending || selected.size === 0,
                onClick: () => setDialog('delete'),
              }, h(TrashIcon), `${t('action.delete')} (${selected.size})`),
            ],
          },
          sessions.length === 0
            ? h('div', { className: 'sc-empty' }, t('empty.sessions'))
            : h('table', { className: 'sc-table' },
              h('thead', null,
                h('tr', null,
                  h('th', { style: { width: 40 } },
                    h('input', {
                      type: 'checkbox',
                      className: 'sc-check',
                      checked: allSelected,
                      disabled: selectableIds.length === 0 || pending,
                      onChange: toggleAll,
                      'aria-label': t('select.all'),
                    })),
                  h('th', null, t('col.title')),
                  h('th', { style: { width: 160 } }, t('col.workspace')),
                  h('th', { style: { width: 92 } }, t('col.size')),
                  h('th', { style: { width: 92 } }, t('col.cache')),
                  h('th', { style: { width: 96 } }, t('col.status')))),
              h('tbody', null,
                sessions.map((session) => h('tr', { key: session.id },
                  h('td', null,
                    h('input', {
                      type: 'checkbox',
                      className: 'sc-check',
                      checked: selected.has(session.id),
                      disabled: !session.deletable || pending,
                      onChange: () => toggle(session.id),
                      'aria-label': session.title,
                    })),
                  h('td', null,
                    h('div', { className: 'sc-cell-title' },
                      h('span', { title: session.title }, session.title),
                      h('span', { className: 'sc-cell-sub', title: session.cwd ?? session.id },
                        session.cwd ?? session.id))),
                  h('td', null,
                    h('span', { className: 'sc-cell-sub', style: { fontSize: 12.5, color: 'var(--sc-muted)' } },
                      session.workspaceTitle ?? '—')),
                  h('td', { className: 'sc-num' }, formatBytes(session.bytes)),
                  h('td', { className: 'sc-num' }, formatBytes(session.cacheBytes)),
                  h('td', null, statusTag(session))))))),

          h(Section, {
            title: t('section.orphans'),
            count: `${orphans.length}`,
            hint: t('hint.orphans'),
            actions: [
              h('button', {
                key: 'sweep',
                type: 'button',
                className: 'sc-btn',
                disabled: pending || (orphans.length === 0 && orphanCaches.length === 0),
                onClick: () => setDialog('sweep'),
              }, t('action.sweep')),
            ],
          },
          orphans.length === 0
            ? h('div', { className: 'sc-empty' }, t('empty.orphans'))
            : h('div', { className: 'sc-list' },
              orphans.map((orphan) => h('div', { key: orphan.id, className: 'sc-row' },
                h('div', { className: 'sc-row-main' },
                  h('span', { className: 'sc-row-name', title: orphan.id }, orphan.id),
                  h('span', { className: 'sc-row-sub', title: orphan.dir }, orphan.dir)),
                h('div', { className: 'sc-row-side' },
                  h('span', { className: 'sc-tag', 'data-tone': 'muted' }, t('status.orphan')),
                  h('span', { className: 'sc-num' }, formatBytes(orphan.bytes + orphan.cacheBytes))))))),

          h(Section, {
            title: t('section.orphanCaches'),
            count: `${orphanCaches.length}`,
            hint: t('hint.orphanCaches'),
          },
          orphanCaches.length === 0
            ? h('div', { className: 'sc-empty' }, t('empty.orphanCaches'))
            : h('div', { className: 'sc-list' },
              orphanCaches.map((cache) => h('div', { key: cache.id, className: 'sc-row' },
                h('div', { className: 'sc-row-main' },
                  h('span', { className: 'sc-row-name', title: cache.id }, cache.id),
                  h('span', { className: 'sc-row-sub', title: cache.path }, cache.path)),
                h('div', { className: 'sc-row-side' },
                  h('span', { className: 'sc-num' }, formatBytes(cache.bytes))))))),

          h(Section, {
            title: t('section.trash'),
            count: `${trash.length}`,
            hint: t('hint.trash'),
          },
          trash.length === 0
            ? h('div', { className: 'sc-empty' }, t('empty.trash'))
            : h('div', { className: 'sc-list' },
              trash.map((batch) => h('div', { key: batch.stamp, className: 'sc-row' },
                h('div', { className: 'sc-row-main' },
                  h('span', { className: 'sc-row-name' }, batch.stamp),
                  h('span', { className: 'sc-row-sub' },
                    `${batch.entries.length} · ${formatBytes(batch.bytes)} · `
                    + (batch.purgeable
                      ? t('retention.purgeable')
                      : t('retention.wait', { days: batch.remainingDays })))),
                h('div', { className: 'sc-row-side' },
                  h('button', {
                    type: 'button',
                    className: 'sc-btn',
                    disabled: pending,
                    onClick: () => restoreStamp(batch.stamp, batch.entries.map((item) => item.id)),
                  }, h(UndoIcon), t('action.restore')),
                  h('button', {
                    type: 'button',
                    className: 'sc-btn',
                    'data-variant': 'danger',
                    disabled: pending || !batch.purgeable,
                    title: batch.purgeable ? '' : t('retention.days', { days: retentionDays }),
                    onClick: () => setDialog({ kind: 'purge', stamp: batch.stamp }),
                  }, t('action.purge'))))))),

          dialog === 'delete' ? h(Dialog, {
            title: t('confirm.title'),
            lines: [
              t('confirm.body', { days: retentionDays }),
              sessions.some((item) => selected.has(item.id) && !item.deletable) ? t('confirm.live') : null,
            ].filter(Boolean),
            confirmLabel: `${t('action.confirm')} (${selected.size})`,
            danger: true,
            onCancel: () => setDialog(null),
            onConfirm: confirmDelete,
          }) : null,

          dialog === 'sweep' ? h(Dialog, {
            title: t('action.sweep'),
            lines: [t('confirm.sweep')],
            confirmLabel: t('action.confirm'),
            danger: true,
            onCancel: () => setDialog(null),
            onConfirm: confirmSweep,
          }) : null,

          dialog && typeof dialog === 'object' && dialog.kind === 'purge' ? h(Dialog, {
            title: t('action.purge'),
            lines: [t('confirm.purge')],
            confirmLabel: t('action.purge'),
            danger: true,
            onCancel: () => setDialog(null),
            onConfirm: () => purgeStamp(dialog.stamp),
          }) : null))
    }

    /* -------------------------------------------------------------- 注册 */

    return {
      inject: ['slots'],
      apply(ctx) {
        // locale 服务晚于 apply 就绪：直接 get 会拿到 undefined，界面就回落成英文。
        // 先试一次，拿不到就挂一个 ctx.inject 等它，和宿主其他面板插件同一套做法。
        if (!attachLocale(ctx) && typeof ctx.inject === 'function') {
          try {
            ctx.inject(['locale'], () => {
              attachLocale(ctx)
              localeBridge.notify()
            })
          } catch (error) {
            console.warn('[dsh-session-cleanup] waiting for the locale service failed:', error)
          }
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => t('panel.title'),
        }, CleanupIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, CleanupPage))
      },
    }
  },
})
