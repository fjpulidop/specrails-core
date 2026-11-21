/**
 * Electron headless guard (compiled to `electron-headless-guard.cjs`).
 *
 * Core loads this file into the Node processes it starts for agents and
 * verification (`NODE_OPTIONS=--require`, see `headlessEnvironment` in
 * pipeline-state.ts). It does nothing unless `SPECRAILS_HEADLESS=1`:
 *
 * - In an Electron main process, windows keep working (rendering, input,
 *   `capturePage`, Playwright) and report `isVisible()` as the app expects,
 *   but are transparent, click-through, never focused, and the app never
 *   activates or shows a Dock icon. The person keeps using the machine while
 *   a run's desktop tests execute.
 * - In plain Node (a test runner, a launcher), it puts itself back into the
 *   `NODE_OPTIONS` of every child that still carries `SPECRAILS_HEADLESS=1`,
 *   because tools such as Playwright's Electron launcher drop `NODE_OPTIONS`.
 *
 * It is plain CommonJS without imports and never throws: it must load in any
 * Node or Electron version a project uses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
;(function specrailsElectronHeadlessGuard(): void {
  const host = globalThis as any
  const proc = process as any
  if (process.env.SPECRAILS_HEADLESS !== '1' || !process.versions || host.__specrailsHeadlessGuard) return
  const quiet = <T,>(fn: () => T): T | undefined => { try { return fn() } catch { return undefined } }
  const option = '--require ' + JSON.stringify(__filename)

  if (!process.versions.electron) {
    host.__specrailsHeadlessGuard = { forwarding: true }
    quiet(() => {
      const { existsSync } = require('fs') as typeof import('fs')
      const { ChildProcess } = require('child_process') as any
      const spawn = ChildProcess.prototype.spawn
      ChildProcess.prototype.spawn = function (this: unknown, options: any) {
        quiet(() => {
          const pairs: unknown[] | null = options && Array.isArray(options.envPairs) ? options.envPairs : null
          if (!pairs || !pairs.includes('SPECRAILS_HEADLESS=1')) return
          const at = pairs.findIndex((pair) => typeof pair === 'string' && pair.startsWith('NODE_OPTIONS='))
          const current = at < 0 ? '' : (pairs[at] as string).slice('NODE_OPTIONS='.length)
          // The option quotes the path (JSON), which doubles Windows backslashes: match either spelling.
          if (current.includes(JSON.stringify(__filename)) || current.includes(__filename) || !existsSync(__filename)) return
          const next = pairs.slice()
          const value = 'NODE_OPTIONS=' + (current ? current + ' ' : '') + option
          if (at < 0) next.push(value); else next[at] = value
          options = Object.assign({}, options, { envPairs: next })
        })
        return spawn.call(this, options)
      }
    })
    return
  }
  if (proc.type !== 'browser') return

  const state = host.__specrailsHeadlessGuard = { windows: 0, app: false }
  const define = (target: any, name: string, value: unknown): void => { quiet(() => Object.defineProperty(target, name, { value, writable: true, configurable: true })) }
  let setOpacity: ((this: any, opacity: number) => void) | null = null
  const conceal = (win: any): void => {
    if (quiet(() => win.isDestroyed())) return
    const opacity = setOpacity
    if (opacity) quiet(() => opacity.call(win, 0))
    quiet(() => win.setIgnoreMouseEvents(true))
    quiet(() => win.setSkipTaskbar(true))
  }
  const patched = new WeakSet<object>()
  const patchWindows = (proto: any): void => {
    if (!proto || patched.has(proto)) return
    patched.add(proto)
    const showInactive = proto.showInactive
    if (typeof showInactive !== 'function') return
    if (!setOpacity && typeof proto.setOpacity === 'function') setOpacity = proto.setOpacity
    const reveal = function (this: any): unknown { conceal(this); return showInactive.call(this) }
    define(proto, 'show', reveal)
    define(proto, 'showInactive', reveal)
    define(proto, 'focus', function () { /* never take focus */ })
    define(proto, 'moveTop', function () { /* never raise over the person's windows */ })
    define(proto, 'setOpacity', function () { /* stays transparent */ })
  }
  // `new BrowserWindow({ show: true })` (the default) shows from native code
  // before any JS method runs, so the constructor itself is wrapped: the window
  // is created hidden, concealed, then shown without activation.
  const wrap = (Native: any): any => new Proxy(Native, {
    construct(target, args: any[], newTarget) {
      patchWindows(target.prototype)
      const options = args[0] && typeof args[0] === 'object' ? args[0] : {}
      const visible = options.show !== false
      const win = Reflect.construct(target, [Object.assign({}, options, { show: false }), ...args.slice(1)], newTarget)
      state.windows++
      conceal(win)
      if (visible) quiet(() => win.showInactive())
      return win
    },
  })
  const linked = proc._linkedBinding
  if (typeof linked === 'function') {
    const wrapped = new Map<string, unknown>()
    proc._linkedBinding = function (this: unknown, name: string, ...rest: unknown[]): unknown {
      const binding = linked.call(this, name, ...rest)
      if ((name !== 'electron_browser_window' && name !== 'electron_browser_base_window') || !binding) return binding
      if (!wrapped.has(name)) {
        const copy: Record<string, unknown> = Object.assign({}, binding)
        for (const key of ['BrowserWindow', 'BaseWindow']) if (typeof binding[key] === 'function') copy[key] = wrap(binding[key])
        wrapped.set(name, copy)
      }
      return wrapped.get(name)
    }
  }
  // `require('electron')` resolves to Electron's API only after this preload
  // (earlier it would cache the npm package path), and the app is not ready yet.
  setImmediate(() => quiet(() => {
    const electron = require('electron') as any
    const app = electron && electron.app
    if (!app || typeof app.on !== 'function') return
    state.app = true
    if (electron.BaseWindow) patchWindows(electron.BaseWindow.prototype)
    if (process.platform === 'darwin') {
      const setPolicy = app.setActivationPolicy
      const accessory = (): void => { quiet(() => setPolicy.call(app, 'accessory')) }
      accessory()
      app.once('ready', accessory)
      define(app, 'setActivationPolicy', function () { /* stays an accessory app */ })
      if (app.dock) {
        quiet(() => app.dock.hide())
        define(app.dock, 'show', function () { return Promise.resolve() })
        define(app.dock, 'bounce', function () { return -1 })
      }
    }
    define(app, 'focus', function () { /* never activate */ })
    define(app, 'show', function () { /* never unhide */ })
  }))
})()
