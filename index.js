/**
 * dsh-side-terminal
 * Take over the sidebar (browser) terminals of the current session.
 *
 * The sidebar terminals are owned by `terminalController`, a typed Remote
 * service. This plugin registers model-facing tools that:
 *   - list the session's sidebar terminals (`terminal/list`)
 *   - open a new one (`terminal/create`)
 *   - close one (`terminal/close`)
 *   - read a terminal's rendered screen
 *   - write input to a terminal with dangerous-command confirmation
 *
 * Every write that looks dangerous (rm -rf, git reset --hard, shutdown, …)
 * asks the user for confirmation through `ctx.approval` before a single byte
 * reaches the terminal. Reads are always free.
 *
 * Input-control contract: NEITHER reading nor writing opens a `terminal/attach`
 * stream while a live BrowserTerminal is reachable in-process. Reading
 * snapshots the controller's xterm screen directly; writing goes straight
 * into the PTY handle. The sidebar view therefore never loses input control,
 * renders NO read-only banner, and keeps its full screen height. A transient
 * attach fallback remains for terminals outside the live registry (e.g.
 * after a Host restart).
 *
 * The bundle also declares the 【终端模式】 agent preset (id `terminal`):
 * sandboxed bash/pwsh tools are omitted from the composition and a guard
 * subpath plugin denies any such invocation that still reaches execution.
 *
 * Tool definitions are plain objects accepted by the shared tool registry;
 * the Config schema is validated leniently at runtime.
 */

/** Services this plugin needs; optional ones are checked at runtime. */
export const inject = ['tools', 'typertGateway', 'connection', 'systemPrompt', 'approval']

const DEFAULT_MAX_READ_CHARS = 40000
const DEFAULT_WAIT_FOR_ECHO_MS = 15000

// ---------------------------------------------------------------------------
// Tool definition helpers (plain objects for the shared tool registry)
// ---------------------------------------------------------------------------

/** Define one model-facing tool without importing @deepseek-ai/dsh-tools. */
function tool({ name, description, parameters, outputSchema, render, execute, finalizeContent, presentCall, presentResult }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render,
    },
    execute,
    ...(finalizeContent === undefined ? {} : { finalizeContent }),
    ...(presentCall === undefined ? {} : { presentCall }),
    ...(presentResult === undefined ? {} : { presentResult }),
  }
}

function textResult(text) {
  return [{ type: 'text', text }]
}

// ---------------------------------------------------------------------------
// Terminal Remote helpers
// ---------------------------------------------------------------------------

/**
 * Dispatch one unary `terminal/<method>` call through the typed Remote
 * gateway with the shared browser owner Peer. Strict generated descriptors
 * accept wire argument names (`agentId`, `id`, `sessionId`, `title`) because
 * the Gateway maps them to the declared parameters.
 */
async function terminalCall(ctx, method, args, signal) {
  const gateway = ctx.typertGateway
  if (gateway === undefined) {
    throw new Error('side-terminal: ctx.typertGateway is unavailable in this composition')
  }
  const connection = ctx.connection
  if (connection === undefined || connection.browserPeer === undefined) {
    throw new Error('side-terminal: ctx.connection.browserPeer is unavailable in this composition')
  }
  return gateway.invoke({
    namespace: 'terminal',
    method,
    args: args ?? {},
    peer: connection.browserPeer,
    signal,
  })
}

/** Resolve the live agent of this session for agent-bearing calls. */
function requireAgent(exec) {
  const agent = exec.agent
  if (agent === undefined) throw new Error('side-terminal tools require an initiating agent')
  return agent
}

/** Open an attach stream through the gateway; returns { iter, send, close }. */
function attachTerminal(ctx, agent, id, signal) {
  let sequence = 0
  const pending = []
  const waiters = []
  let taken = false
  const channel = {
    async next() {
      const item = pending.shift()
      // Async iterator protocol: always return an IteratorResult.
      if (item !== undefined) return { value: item, done: false }
      if (taken) return { done: true }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
    },
    return() {
      taken = true
      for (const waiter of waiters.splice(0)) waiter.resolve({ done: true })
      return Promise.resolve({ done: true })
    },
    [Symbol.asyncIterator]() { return this },
  }
  // Dedicated controller: aborting it unblocks a downlink generator that is
  // parked waiting for the next frame, so close() completes immediately.
  const controller = new AbortController()
  const ownSignal = AbortSignal.any([signal, controller.signal])
  const streamPromise = ctx.typertGateway.stream({
    namespace: 'terminal',
    method: 'attach',
    args: { agentId: agent.id, id },
    uplink: channel,
    peer: ctx.connection.browserPeer,
    signal: ownSignal,
  })
  const iterPromise = streamPromise.then(stream => stream[Symbol.asyncIterator]())
  let closed = false
  return {
    iter: iterPromise,
    send(command) {
      if (taken) throw new Error('terminal attach uplink is closed')
      sequence += 1
      const item = { ...command, sequence }
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter.resolve({ value: item, done: false })
      else pending.push(item)
      return sequence
    },
    /**
     * Stop consuming and end the downlink generation; idempotent.
     * `waitQuiesce` controls whether close() waits for the downlink
     * generation to fully unwind. The default true is the safe path;
     * after an acknowledged write, false releases the input controller
     * immediately (the banner disappears as soon as possible) while the
     * generation tears down in the background.
     */
    async close(waitQuiesce = true) {
      if (closed) return
      closed = true
      channel.return()
      controller.abort(new Error('side-terminal attach closed'))
      if (!waitQuiesce) return
      try {
        const iter = await iterPromise
        await iter.return?.()
      } catch {
        // The stream may have failed before its iterator existed; closing the uplink suffices.
      }
    },
  }
}

/**
 * Single-consumer pump over an attach downlink: one iterator.next() is in
 * flight at a time and frames land in a local queue. `read()` consumes the
 * queue with a deadline; `close()` ends the pump and the downlink generation.
 */
function attachReader(attach) {
  const frames = []
  const waiters = []
  let done = false
  const pump = (async () => {
    try {
      const iter = await attach.iter
      while (true) {
        const next = await iter.next()
        if (next.done === true) break
        if (next.value !== undefined) {
          frames.push(next.value)
          for (const resolve of waiters.splice(0)) resolve()
        }
      }
    } catch {
      // Downlink failure; readers observe an empty queue.
    } finally {
      done = true
      for (const resolve of waiters.splice(0)) resolve()
    }
  })()
  return {
    /** Read one frame, waiting at most `remaining` ms. */
    async read(remaining) {
      while (frames.length === 0 && !done) {
        const wait = new Promise(resolve => waiters.push(resolve))
        await Promise.race([wait, new Promise(resolve => setTimeout(resolve, remaining))])
        if (frames.length === 0 && !done) return undefined
      }
      return frames.shift()
    },
    /** End the pump and the underlying downlink. */
    close(waitQuiesce) {
      return attach.close(waitQuiesce)
    },
    pump,
  }
}

// ---------------------------------------------------------------------------
// Non-invasive screen snapshot (no input control taken)
// ---------------------------------------------------------------------------

/**
 * Resolve the live Host instance backing the Session's terminals without a
 * Remote round-trip: read the service implementation's private `owners`
 * registry directly from the controller's own context.
 */
function controllerInternals(ctx) {
  const controller = ctx.get('terminalController')
  if (controller === null || typeof controller !== 'object') return undefined
  const owners = controller.owners
  if (!(owners instanceof Map)) return undefined
  return { controller, owners }
}

/** Resolve the BrowserTerminal for one sidebar id, or undefined. */
function resolveBrowserTerminal(ctx, agent, id) {
  const internals = controllerInternals(ctx)
  if (internals === undefined) return undefined
  const owner = internals.owners.get(agent.id)
  if (owner === undefined || typeof owner !== 'object' || owner === null) return undefined
  const terminals = owner.terminals
  if (!(terminals instanceof Map)) return undefined
  const terminal = terminals.get(id)
  return terminal === undefined ? undefined : terminal
}

/**
 * Read one terminal's rendered screen WITHOUT opening an attach stream:
 * serialize the xterm screen and strip it in-process. The browser keeps its
 * input control and the sidebar renders no read-only banner.
 */
function snapshotScreen(browserTerminal, strip) {
  const serializer = browserTerminal.serializer
  if (serializer === null || typeof serializer !== 'object') {
    throw new Error('side-terminal_read: terminal screen serializer is unavailable')
  }
  const serialize = serializer.serialize
  if (typeof serialize !== 'function') {
    throw new Error('side-terminal_read: terminal screen serializer is unavailable')
  }
  const screen = serialize.call(serializer)
  const text = screenText(screen, strip)
  return {
    screen,
    text,
    truncated: text.length >= DEFAULT_MAX_READ_CHARS,
    screenBytes: Buffer.byteLength(screen ?? '', 'utf8'),
  }
}

/**
 * Write bytes straight into the terminal's PTY handle WITHOUT opening an
 * attach stream: the sidebar view never loses input control, so no read-only
 * banner appears and the screen keeps its full height. This mirrors exactly
 * what `BrowserTerminal.consumeInput` does for an attach write, including
 * invalidating the unattended-reclamation observation.
 */
async function writeToPty(browserTerminal, data) {
  const handle = browserTerminal.handle
  if (handle === null || typeof handle !== 'object' || typeof handle.write !== 'function') {
    throw new Error('side-terminal_write: terminal PTY handle is unavailable')
  }
  if (browserTerminal.exited === true
    || browserTerminal.closing !== undefined
    || browserTerminal.info?.state !== 'running') {
    throw new Error(`side-terminal_write: terminal is not running (state: ${describeState(browserTerminal.info)})`)
  }
  browserTerminal.retention?.invalidate?.()
  await handle.write(data)
}

// ---------------------------------------------------------------------------
// Screen rendering
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences; aggressive but adequate for read results. */
function stripAnsi(text) {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/** xterm-serializer screen → one readable plain-text block. */
function screenText(screen, strip) {
  const content = (screen ?? '').replace(/(?:\u001b\]8;[^\u001b\\]*\u001b\\)?/g, '')
  const cleaned = strip ? stripAnsi(content) : content
  const lines = cleaned.split('\n')
  const tail = lines.length > 600 ? lines.slice(-600) : lines
  const text = tail.join('\n').replace(/[ \t]+\n/g, '\n')
  return text.length > DEFAULT_MAX_READ_CHARS ? text.slice(-DEFAULT_MAX_READ_CHARS) : text
}

function describeState(info) {
  if (info === undefined) return 'unknown'
  if (info.state === 'running') return 'running'
  if (info.state === 'exited') return `exited (${info.exitCode ?? 'unknown'})`
  return `failed (${info.error ?? 'unknown'})`
}

// ---------------------------------------------------------------------------
// Dangerous-command confirmation
// ---------------------------------------------------------------------------

/** Built-in patterns that always require confirmation before a send. */
const DEFAULT_DANGEROUS = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/|~|\$HOME|\.\.)/, label: 'recursive/forced delete outside the working tree' },
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+-?/, label: 'recursive delete with force flags' },
  { pattern: /(^|[;&|]\s*)(rm|del|erase)\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\//, label: 'delete command on an absolute path' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|checkout\s+--\s)/, label: 'destructive git history/working-tree change' },
  { pattern: /\bgit\s+push\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)|\bgit\s+push[^|;&]*--force/, label: 'force push' },
  { pattern: /\b(mkfs|dd\s+if=.*\s+of=\/dev\/)/, label: 'disk device write' },
  { pattern: /\b(reboot|shutdown|halt|poweroff)\b/, label: 'system power control' },
  { pattern: /\bkill(all)?\s+-9\s+/, label: 'SIGKILL' },
  { pattern: /\b(chmod|chown)\s+-R\s+/, label: 'recursive ownership/permission change' },
  { pattern: /\bmv\s+[^;&|]*\/(etc|usr|bin|sbin|lib|boot)\b/, label: 'move into a system directory' },
  { pattern: /\b(sudo|doas|su)\s+/, label: 'privilege elevation' },
  { pattern: /\b(curl|wget)\b[^;&|]*\|\s*(sh|bash|zsh)\b/, label: 'pipe remote content into a shell' },
  { pattern: /\bchmod\s+[0-7]*777\b/, label: 'world-writable permissions' },
  { pattern: /(^|[;&|]\s*)export\s+.*(PATH|LD_PRELOAD|LD_LIBRARY_PATH)=/, label: 'environment poisoning' },
  { pattern: /\bhistory\s+-c\b|\brm\s+.*(\.bash_history|\.zsh_history)\b/, label: 'shell history tampering' },
  { pattern: /(^|\s)init\s+0\b|(^|\s)systemctl\s+(poweroff|reboot|halt)\b/, label: 'system shutdown via init system' },
  { pattern: /\btruncate\s+(-s[^;&|]*\s+)?\//, label: 'truncate an absolute path' },
  { pattern: /\bopenssl\s+(enc\s+-d|rsautl|pkeyutl)\b/, label: 'cryptographic secret material operation' },
  { pattern: /\b(gpg|age|ssh-keygen)\s+--?d/, label: 'key/secret deletion' },
]

/** Compile the effective pattern list from defaults plus config extras. */
function compileDangerous(extra) {
  const list = DEFAULT_DANGEROUS.map(item => ({ ...item }))
  let skipped = 0
  for (const source of extra ?? []) {
    if (typeof source !== 'string' || source.length === 0) continue
    try {
      list.push({ pattern: new RegExp(source), label: `user pattern: ${source}` })
    } catch {
      skipped++
    }
  }
  return { list, skipped }
}

/** Evaluate one command against the danger list. */
function dangerousMatch(command, list) {
  for (const item of list) {
    if (item.pattern.test(command)) return item
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Parameter validation (lenient stand-in for defineTool's strict validation)
// ---------------------------------------------------------------------------

function expectString(value, field) {
  if (typeof value !== 'string') throw new Error(`side-terminal: ${field} must be a string`)
  return value
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** Register the sidebar-terminal tools. */
export function apply(ctx, config = {}) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.tools !== 'object') {
    throw new Error('side-terminal: unexpected plugin context')
  }
  const dangerous = compileDangerous(config.dangerousPatterns ?? [])
  if (dangerous.skipped > 0) {
    ctx.logger?.warn?.(`side-terminal: ${dangerous.skipped} dangerousPatterns entries are not valid regexes and were skipped`)
  }
  const waitForEchoMs = Number.isFinite(config.waitForEchoMs) && config.waitForEchoMs >= 200
    ? config.waitForEchoMs : DEFAULT_WAIT_FOR_ECHO_MS
  const strip = config.stripAnsi !== false

  ctx.systemPrompt.section({
    name: 'tool:side-terminal',
    order: 500,
    text: 'Sidebar terminal tools drive the terminals the user opened in the sidebar of this session. '
      + 'Prefer them only when the user explicitly asked to operate that specific terminal; '
      + 'prefer the bash tool for ordinary commands. List terminals with side_terminal_list, '
      + 'read their visible screen with side_terminal_read, and send input with side_terminal_write '
      + '(Enter is submitted automatically). Dangerous commands require user confirmation; never try to '
      + 'bypass it by splitting, encoding, or quoting a command.',
  })

  // ---- list ---------------------------------------------------------------
  ctx.tools.register(tool({
    name: 'side_terminal_list',
    description: 'List the sidebar (browser) terminals of the current session with their ids, titles, shells, sizes, and states. Use the returned terminal id with the other side_terminal_* tools.',
    parameters: {},
    outputSchema: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          shell: { type: 'string' },
          cwd: { type: 'string' },
          cols: { type: 'integer' },
          rows: { type: 'integer' },
          state: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
        required: ['id', 'title', 'shell', 'cwd', 'cols', 'rows', 'state', 'exitCode'],
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.length === 0
        ? 'No sidebar terminals are open for this session.'
        : value.map(info =>
          `- ${info.id} | ${info.title} | ${info.shell} | ${info.cwd} | ${info.cols}x${info.rows} | ${info.state}`,
        ).join('\n'),
    }],
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      const result = await terminalCall(ctx, 'list', { sessionId: agent.id }, exec.signal)
      const list = Array.isArray(result) ? result : []
      return list.map(info => ({
        id: info.id,
        title: info.title,
        shell: info.shell?.name ?? String(info.shell?.path ?? ''),
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
        state: info.state,
        exitCode: info.exitCode,
      }))
    },
    presentCall: () => ({ card: 'generic', title: 'List sidebar terminals', kind: 'read' }),
  }))

  // ---- read ---------------------------------------------------------------
  ctx.tools.register(tool({
    name: 'side_terminal_read',
    description: 'Read the current visible screen of one sidebar terminal of this session. Returns the latest rendered output as plain text, including the prompt line when the shell is idle. Reading never disturbs the terminal and never takes input control away from the sidebar view.',
    parameters: {
      terminal_id: { type: 'string', required: true, description: 'Terminal id returned by side_terminal_list.' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string' },
        state: { type: 'string' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        screenBytes: { type: 'integer' },
      },
      required: ['terminalId', 'state', 'text', 'truncated', 'screenBytes'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: `[${value.state}] screen (${value.screenBytes} bytes${value.truncated ? ', truncated' : ''}):\n${value.text}`,
    }],
    finalizeContent: (_exec, result) => {
      const raw = result.content
      if (raw.length !== 1 || raw[0]?.type !== 'text') return undefined
      const text = raw[0].text
      return textResult(text.length > DEFAULT_MAX_READ_CHARS ? text.slice(-DEFAULT_MAX_READ_CHARS) : text)
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const id = expectString(args.terminal_id, 'terminal_id')
      if (id.length === 0) throw new Error('side_terminal_read: terminal_id must be a non-empty string')
      // Non-invasive path: snapshot the live xterm screen in-process without
      // opening an attach stream, so the sidebar keeps input control.
      const terminal = resolveBrowserTerminal(ctx, agent, id)
      if (terminal !== undefined) {
        const snap = snapshotScreen(terminal, strip)
        return {
          terminalId: id,
          state: describeState(terminal.info),
          text: snap.text,
          truncated: snap.truncated,
          screenBytes: snap.screenBytes,
        }
      }
      // Fallback: a terminal outside this controller's live registry (e.g.
      // after a Host restart) is read through a transient attach.
      const attach = attachTerminal(ctx, agent, id, exec.signal)
      const reader = attachReader(attach)
      try {
        const deadline = Date.now() + 3000
        let snapshot
        while (Date.now() < deadline) {
          const frame = await reader.read(Math.max(50, deadline - Date.now()))
          if (frame === undefined) break
          if (frame.type === 'snapshot') {
            snapshot = frame
            break
          }
        }
        if (snapshot === undefined) {
          throw new Error(`side_terminal_read: terminal ${id} did not deliver a screen snapshot`)
        }
        const text = screenText(snapshot.screen, strip)
        return {
          terminalId: id,
          state: describeState(snapshot.info),
          text,
          truncated: text.length >= DEFAULT_MAX_READ_CHARS,
          screenBytes: Buffer.byteLength(snapshot.screen ?? '', 'utf8'),
        }
      } finally {
        await reader.close(false)
      }
    },
    presentCall: args => ({ card: 'generic', title: `Read sidebar terminal ${args.terminal_id}`, kind: 'read' }),
  }))

  // ---- write --------------------------------------------------------------
  ctx.tools.register(tool({
    name: 'side_terminal_write',
    description: 'Send input to one sidebar terminal of this session, exactly as if typed into it. The plugin submits Enter automatically when the input does not already end with "\\r". Dangerous commands (destructive deletes, privilege elevation, shutdown, force pushes, remote-code pipes, …) ask the user for confirmation first and are rejected unless confirmed. Writing never takes input control away from the sidebar view.',
    parameters: {
      terminal_id: { type: 'string', required: true, description: 'Terminal id returned by side_terminal_list.' },
      input: { type: 'string', required: true, description: 'Exact text to type, escape sequences included. End with "\\r" to submit like Enter.' },
      confirmed_by_user: { type: 'boolean', description: 'Set true ONLY after the user explicitly approved this exact command text in the conversation. Forgetting the confirmation asks again (fail-closed).' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string' },
        sent: { type: 'string' },
        echoed: { type: 'boolean' },
        confirmation: { type: 'string', enum: ['not-needed', 'approved', 'required'] },
        tail: { type: 'string' },
      },
      required: ['terminalId', 'sent', 'echoed', 'confirmation', 'tail'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: [
        `confirmation: ${value.confirmation}`,
        `echoed: ${value.echoed}`,
        `sent: ${JSON.stringify(value.sent)}`,
        '--- terminal tail ---',
        value.tail,
      ].join('\n'),
    }],
    finalizeContent: (_exec, result) => {
      const raw = result.content
      if (raw.length !== 1 || raw[0]?.type !== 'text') return undefined
      const text = raw[0].text
      return textResult(text.length > DEFAULT_MAX_READ_CHARS ? text.slice(-DEFAULT_MAX_READ_CHARS) : text)
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const id = expectString(args.terminal_id, 'terminal_id')
      if (id.length === 0) throw new Error('side_terminal_write: terminal_id must be a non-empty string')
      const input = expectString(args.input, 'input')
      if (input.length === 0) throw new Error('side_terminal_write: input must be a non-empty string')
      const clean = input.replace(/\r\n/g, '\r').replace(/\n/g, '\r')

      // 1. Dangerous-command confirmation, before anything reaches the PTY.
      const match = dangerousMatch(clean, dangerous.list)
      if (match !== undefined && args.confirmed_by_user !== true) {
        const approval = ctx.get('approval')
        if (approval === undefined) {
          throw new Error(
            'side_terminal_write: this command matches a dangerous pattern '
            + `(${match.label}) and confirmation is required, but the approval service is unavailable. Nothing was sent.`,
          )
        }
        const outcome = await approval.request({
          agent,
          toolName: 'side_terminal_write',
          callId: exec.callId,
          reason: `Dangerous command for sidebar terminal ${id}: ${JSON.stringify(clean)} (matches: ${match.label})`,
          displayReason: {
            en: `Send this command to sidebar terminal "${id}"? It matches the dangerous pattern "${match.label}".`,
            zh: `要把这条命令发送到侧边栏终端“${id}”吗？它命中了危险模式“${match.label}”。`,
          },
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(`side_terminal_write: dangerous command was not confirmed (${outcome}). Nothing was sent.`)
        }
      }
      const confirmation = match !== undefined ? 'approved' : 'not-needed'

      // 2. Write straight into the PTY WITHOUT opening an attach stream, so
      // the sidebar view never loses input control and renders no read-only
      // banner. The xterm screen is its own renderer: the browser's attached
      // view receives the shell's echo as ordinary PTY output, exactly as if
      // the user had typed it. The controller's screen follows every PTY
      // chunk through `BrowserTerminal.consume`, so a later read sees it.
      const terminal = resolveBrowserTerminal(ctx, agent, id)
      if (terminal !== undefined) {
        const needsReturn = !clean.endsWith('\r')
        await writeToPty(terminal, clean)
        if (needsReturn) await writeToPty(terminal, '\r')
        // Give the shell a moment to echo before reading the tail back.
        await new Promise(resolve => setTimeout(resolve, 120))
        const snap = snapshotScreen(terminal, strip)
        const tail = snap.text.length > 4000 ? snap.text.slice(-4000) : snap.text
        return {
          terminalId: id,
          sent: clean,
          echoed: true,
          confirmation,
          tail,
        }
      }

      // Fallback: a terminal outside this controller's live registry (e.g.
      // after a Host restart) is written through a transient attach.
      const attach = attachTerminal(ctx, agent, id, exec.signal)
      const reader = attachReader(attach)
      try {
        const deadline = Date.now() + 3000
        let first
        while (Date.now() < deadline && first === undefined) {
          const frame = await reader.read(Math.max(50, deadline - Date.now()))
          if (frame === undefined) break
          first = frame
        }
        if (first === undefined || first.type !== 'snapshot') {
          throw new Error(`side_terminal_write: terminal ${id} did not deliver a screen snapshot before attaching`)
        }
        const writable = first.writable === true
        if (!writable) {
          throw new Error(
            `side_terminal_write: terminal ${id} is not writable (state: ${describeState(first.info)}); input cannot be delivered to a terminated shell`,
          )
        }
        const needsReturn = !clean.endsWith('\r')
        const seq1 = attach.send({ type: 'write', data: clean })
        const seq2 = needsReturn ? attach.send({ type: 'write', data: '\r' }) : seq1
        const ackDeadline = Date.now() + waitForEchoMs
        const outputs = []
        let acked = false
        while (Date.now() < ackDeadline) {
          const out = await reader.read(Math.max(50, ackDeadline - Date.now()))
          if (out === undefined) break
          if (out.type === 'output') {
            outputs.push(out.data)
          } else if (out.type === 'ack') {
            if (out.refusal !== undefined) {
              throw new Error(
                `side_terminal_write: terminal ${id} refused input (${out.refusal}); nothing may have been delivered`,
              )
            }
            if (out.sequence >= seq2) {
              acked = true
              break
            }
          }
        }
        const outText = stripAnsi(outputs.join(''))
        const tail = outText.length > 4000 ? outText.slice(-4000) : outText
        return {
          terminalId: id,
          sent: clean,
          echoed: acked,
          confirmation,
          tail,
        }
      } finally {
        // After a completed or failed write, detach WITHOUT waiting for the
        // downlink generation to unwind: the browser reconnects on its next
        // attach cycle and the read-only banner disappears immediately.
        await reader.close(false)
      }
    },
    presentCall: args => ({ card: 'terminal', title: String(args.input ?? ''), description: `Sidebar terminal ${args.terminal_id}` }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      const raw = result.content
      const text = raw.length === 1 && raw[0]?.type === 'text' ? raw[0].text : undefined
      return text === undefined ? undefined : { card: 'terminal', output: text }
    },
  }))

  // ---- open ---------------------------------------------------------------
  ctx.tools.register(tool({
    name: 'side_terminal_open',
    description: 'Open a new terminal in the sidebar of the current session. The user can see and use it immediately; it also appears in side_terminal_list.',
    parameters: {
      cols: { type: 'number', description: 'Initial width in columns (default 80).' },
      rows: { type: 'number', description: 'Initial height in rows (default 24).' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        shell: { type: 'string' },
        cwd: { type: 'string' },
        cols: { type: 'integer' },
        rows: { type: 'integer' },
        state: { type: 'string' },
      },
      required: ['id', 'title', 'shell', 'cwd', 'cols', 'rows', 'state'],
    },
    render: (_args, value) => [{ type: 'text', text: `opened sidebar terminal ${value.id} (${value.title}, ${value.cwd}, ${value.cols}x${value.rows})` }],
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const cols = Number.isInteger(args.cols) && args.cols >= 2 ? args.cols : 80
      const rows = Number.isInteger(args.rows) && args.rows >= 1 ? args.rows : 24
      const id = `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const info = await terminalCall(ctx, 'create', {
        agentId: agent.id,
        request: { id, cols, rows },
      }, exec.signal)
      return {
        id: info.id,
        title: info.title,
        shell: info.shell?.name ?? String(info.shell?.path ?? ''),
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
        state: info.state,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Open sidebar terminal', kind: 'execute' }),
  }))

  // ---- close --------------------------------------------------------------
  ctx.tools.register(tool({
    name: 'side_terminal_close',
    description: 'Close one sidebar terminal of the current session and kill its process tree. The user sees the tab disappear. Closing also asks for confirmation because it terminates running work.',
    parameters: {
      terminal_id: { type: 'string', required: true, description: 'Terminal id returned by side_terminal_list.' },
      confirmed_by_user: { type: 'boolean', description: 'Set true ONLY after the user explicitly approved closing this exact terminal.' },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string' },
        closed: { type: 'boolean' },
        confirmation: { type: 'string', enum: ['approved', 'required'] },
      },
      required: ['terminalId', 'closed', 'confirmation'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.closed ? `closed sidebar terminal ${value.terminalId}` : `sidebar terminal ${value.terminalId} was already closing`,
    }],
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const id = expectString(args.terminal_id, 'terminal_id')
      if (id.length === 0) throw new Error('side_terminal_close: terminal_id must be a non-empty string')
      if (args.confirmed_by_user !== true) {
        const approval = ctx.get('approval')
        if (approval === undefined) {
          throw new Error('side_terminal_close: confirmation is required, but the approval service is unavailable. Nothing was closed.')
        }
        const outcome = await approval.request({
          agent,
          toolName: 'side_terminal_close',
          callId: exec.callId,
          reason: `Close sidebar terminal ${id} and terminate its process tree`,
          displayReason: {
            en: `Close sidebar terminal "${id}" and terminate everything running in it?`,
            zh: `要关闭侧边栏终端“${id}”并终止其中运行的所有进程吗？`,
          },
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(`side_terminal_close: closing was not confirmed (${outcome}). Nothing was closed.`)
        }
      }
      await terminalCall(ctx, 'close', { agentId: agent.id, id }, exec.signal)
      return { terminalId: id, closed: true, confirmation: 'approved' }
    },
    presentCall: args => ({ card: 'generic', title: `Close sidebar terminal ${args.terminal_id}`, kind: 'delete' }),
  }))
}
