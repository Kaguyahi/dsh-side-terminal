/**
 * 终端模式 preset guard: deny sandboxed shell tools hard.
 *
 * The preset omits `tool-bash`/`tool-pwsh` from its composition, so the tools
 * are absent from the model's catalog. This guard is the enforcement backstop:
 * if a shell tool is still invoked in this scope (profile override, another
 * preset layer, dynamic registration), the execution is denied before the
 * sandbox ever runs it. The sidebar-terminal tools are the only shell surface
 * in this mode.
 */

/** Denied tool names while this plugin is active. */
const DENIED = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send'])

export const inject = ['tools']

export function apply(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.tools !== 'object') {
    throw new Error('side-terminal/guard: unexpected plugin context')
  }
  ctx.effect(() => ctx.tools.guard((execution) => {
    if (DENIED.has(execution.name)) {
      return '终端模式: sandboxed shell tools are disabled; use the side_terminal_* tools to run commands in the sidebar terminals'
    }
    return undefined
  }))
}
