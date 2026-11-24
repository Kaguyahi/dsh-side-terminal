window.__ModuleLoader__.load({
  id: 'dsh-side-terminal',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const TAG = '[side-terminal]'
    // ------------------------------------------------------------------
    // 1. Status pill CSS: floating overlay instead of a layout row, so the
    //    terminal's last line stays visible whenever the host shows a
    //    transient status (read-only banner, reconnecting, loading, …).
    //    The compiled host class is `_5D1QAq_status` (hashed per build), so
    //    target BOTH the stable DOM attribute selectors and the compiled
    //    class name. `!important` wins over the host's flex layout; once
    //    the row leaves the flow, the screen fills the freed height and the
    //    host's own ResizeObserver re-fits xterm automatically.
    // ------------------------------------------------------------------
    const cssId = 'side-terminal-status-overlay'
    if (!document.getElementById(cssId)) {
      const style = document.createElement('style')
      style.setAttribute('id', cssId)
      style.setAttribute('data-plugin', 'dsh-side-terminal')
      style.setAttribute('data-plugin-css', cssId)
      style.textContent = [
        '[data-sidebar-terminal] { position: relative; }',
        '[data-sidebar-terminal] [role="status"],',
        '[data-sidebar-terminal] ._5D1QAq_status {',
        '  position: absolute !important;',
        '  z-index: 2;',
        '  right: 10px;',
        '  top: 10px;',
        '  max-width: calc(100% - 20px);',
        '  padding: 3px 10px;',
        '  border-radius: 999px;',
        '  gap: 6px;',
        '  box-shadow: 0 1px 6px rgba(0, 0, 0, .28);',
        '}',
      ].join('\n')
      document.head.appendChild(style)
    }
    // ------------------------------------------------------------------
    // 2. Terminal watcher with loud diagnostics: every silent-return
    //    branch logs WHY it bailed, so the next browser refresh shows us
    //    the exact failing step in the console.
    // ------------------------------------------------------------------
    function TerminalWatcher({ ctx, sessionId }) {
      React.useEffect(() => {
        console.log(`${TAG} watcher effect start`, { sessionId })
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          console.warn(`${TAG} no sessionId prop; watcher idle`)
          return
        }
        let alive = true
        let timer
        const controller = new AbortController()
        const reconcile = async () => {
          if (!alive) return
          const sidebarRight = ctx.get('sidebarRight')
          // `remote.terminal` is its own Cordis service (mounted by
          // api-remotes into a child fiber); it must be injected and read
          // as a service key, never as a property of `ctx.get('remote')`.
          const terminalNs = ctx.get('remote.terminal')
          if (sidebarRight === undefined || terminalNs === undefined) {
            console.warn(`${TAG} missing services`, {
              sidebarRight: sidebarRight === undefined,
              terminalNamespace: terminalNs === undefined,
            })
            return
          }
          let infos
          try {
            console.log(`${TAG} terminal namespace`, { present: terminalNs !== undefined, keys: typeof terminalNs === 'object' && terminalNs !== null ? Object.keys(terminalNs).slice(0, 12) : [] })
            if (typeof terminalNs.list !== 'function') {
              console.warn(`${TAG} remote.terminal.list is unavailable; namespace may not be mounted`)
              return
            }
            const result = await terminalNs.list(sessionId)
            const value = result?.ok === true ? result.value : (result?.value ?? result)
            infos = Array.isArray(value) ? value : []
            console.log(`${TAG} host terminals`, infos.map(info => info.id))
          } catch (error) {
            console.error(`${TAG} terminal.list failed`, error)
            return
          }
          if (!alive) return
          const byId = new Map(infos.map(info => [info.id, info]))
          const tabs = typeof sidebarRight.tabsIn === 'function'
            ? sidebarRight.tabsIn(sessionId)
            : []
          console.log(`${TAG} ui tabs`, tabs.map(tab => ({ id: tab.id, kind: tab.kind, contentId: tab.contentId })))
          const boundTerminalId = (tab) => {
            if (tab.kind !== 'terminal') return undefined
            // 1. Live navigation params: the opener's terminalId (works for
            //    tabs opened in this page generation).
            try {
              const occurrence = sidebarRight.tabDomain?.occurrence?.(sessionId, { id: tab.id })
              const params = occurrence?.navigation?.getSnapshot?.()?.params
              if (params !== null && typeof params === 'object' && typeof params.terminalId === 'string') {
                return params.terminalId
              }
            } catch {
              // occurrence() throws until the tab record is reconciled.
            }
            // 2. Persisted binding: tabs restored from a saved layout carry
            //    no params, but the terminal client saves contentId →
            //    terminalId in localStorage under a stable prefix.
            try {
              const raw = localStorage.getItem(`dsh.terminal.binding.v1.${JSON.stringify([sessionId, tab.contentId])}`)
              if (raw !== null) {
                const value = JSON.parse(raw)
                if (typeof value === 'string' && /^[\w-]{1,128}$/u.test(value)) return value
              }
            } catch {
              // Storage unavailable; the tab simply stays unreconciled.
            }
            return undefined
          }
          const visibleIds = new Set()
          for (const tab of tabs) {
            const id = boundTerminalId(tab)
            if (id !== undefined) visibleIds.add(id)
          }
          console.log(`${TAG} visible terminal ids`, [...visibleIds])
          for (const info of infos) {
            if (visibleIds.has(info.id)) continue
            try {
              console.log(`${TAG} opening tab for`, info.id)
              sidebarRight.openTabIn(sessionId, 'terminal', { params: { terminalId: info.id } })
            } catch (error) {
              console.warn(`${TAG} openTabIn failed`, error)
            }
          }
          // The right column may be collapsed, so freshly opened tabs stay
          // hidden. Reveal it once so the user sees the terminal appear.
          const openedAny = infos.some(info => !visibleIds.has(info.id))
          if (openedAny) {
            try {
              ctx.get('layout')?.openRightbar?.(true, false)
            } catch (error) {
              console.warn(`${TAG} openRightbar failed`, error)
            }
          }
          for (const tab of tabs) {
            if (tab.kind !== 'terminal') continue
            const bound = boundTerminalId(tab)
            if (bound === undefined) continue
            if (!byId.has(bound)) {
              try {
                console.log(`${TAG} closing tab bound to gone terminal`, bound)
                sidebarRight.closeIn?.(sessionId, tab.id)
              } catch (error) {
                console.warn(`${TAG} closeIn failed`, error)
              }
            }
          }
        }
        const start = () => {
          void reconcile().finally(() => {
            if (!alive) return
            timer = setTimeout(start, 3000)
          })
        }
        start()
        return () => {
          alive = false
          clearTimeout(timer)
          controller.abort()
        }
      }, [sessionId])
      return null
    }
    return {
      inject: ['slots', 'sidebarRight', 'remote.terminal', 'layout'],
      apply(ctx) {
        console.log(`${TAG} client apply: registering header watcher`)
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'side-terminal-watcher',
          order: 15,
        }, function HeaderWatcher(props) {
          const sessionId = props.sessionId
          return h(TerminalWatcher, { ctx, sessionId })
        }))
      },
    }
  },
})