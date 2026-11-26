// @ts-check
// k8s side pane: a clickable, expandable cluster view docked beside the
// Claude Code chat (Cluster, Argo CD, RCA, Lock), drawn by this mod.
//
// Data comes only from the plugin's own k8sh MCP server ($.mcp.call), so
// redaction and the lock stay in one place. The mod never reads kubeconfig
// or secrets. The pane is read-only except Unlock…, which only the person
// can reach: a Button press and an Input they type into. No tool, command
// or prompt leads there.

import { atom, read, update } from 'claude-code'
import { FRAME_MS, infinityCells } from './infinity.js'
import { steveCells } from './steve.js'
import { line as steveLine, persona, toolLine as steveTool } from './steve-lines.js'

/** @typedef {import('claude-code').EngineInterface} Engine */
/** @typedef {import('../types').K8sTab} K8sTab */
/** @typedef {import('../types').K8sNode} K8sNode */
/** @typedef {import('../types').K8sView} K8sView */
/** @typedef {import('../types').K8sData} K8sData */
/** @typedef {import('../types').K8sContext} K8sContext */
/** @typedef {import('../types').K8sGrant} K8sGrant */
/** @typedef {import('../types').K8sStatus} K8sStatus */

const PANE = 'k8s'
const TOOL_PREFIX = 'mcp__plugin_devops-assistant_k8sh__'
const PAGE = 30
const REFRESH_MS = 15000
const DETAIL_MAX_LINES = 300
const WORKLOADS = ['Deployment', 'StatefulSet', 'DaemonSet']
const SHORT = /** @type {Record<string, string>} */ ({ Deployment: 'deploy', StatefulSet: 'sts', DaemonSet: 'ds' })

/** @type {{ id: K8sTab, label: string, hotkey: string }[]} */
const TABS = [
  { id: 'cluster', label: 'Cluster', hotkey: '1' },
  { id: 'argo', label: 'Argo CD', hotkey: '2' },
  { id: 'rca', label: 'RCA', hotkey: '3' },
  { id: 'lock', label: 'Lock', hotkey: '4' },
]

/** @type {K8sView} */
const INITIAL_VIEW = {
  tab: 'cluster',
  context: null,
  expanded: [],
  selected: null,
  detail: null,
  pages: {},
  unlock: null,
  notice: null,
  busy: 0,
}

/** @type {K8sData} */
const INITIAL_DATA = { contexts: [], grants: [], nodes: {}, children: {}, errors: {}, loadedFor: null }

const view = atom({ plugin: 'devops-assistant', key: 'view' }, INITIAL_VIEW, { shape: 'view-1' })
const data = atom({ plugin: 'devops-assistant', key: 'data' }, INITIAL_DATA, { shape: 'data-1' })

// Module state: timers and caches only; a reload starts them over.
/** @type {{ cancel: () => void } | null} */
let timer = null
/** @type {{ cancel: () => void } | null} */
let soon = null
/** @type {string | null} */
let serverName = null
let ticking = false

// The backdrop (Steve or the ∞): its frame loop, the frame number, the size
// of the Raster the last terminal draw mounted (null: none mounted), and how
// many blits in a row the surface refused (the pane hidden: then probe about
// once a second).
const FX_KEY = 'backdrop'
/** @type {'steve' | 'infinity' | 'off'} */
let fxLook = 'steve'
let fxVoice = false
let fxLastKey = ''
/** @type {{ cancel: () => void } | null} */
let fxTimer = null
let fxFrame = 0
/** @type {{ cols: number, rows: number } | null} */
let fxSize = null
let fxMiss = 0
let fxBusy = false
// Under the ∞: the plugin's name and version, from its own plugin.json.
let fxLabel = 'devops-assistant'

/** @param {Engine} $ */
async function loadLabel($) {
  try {
    const { version } = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    if (typeof version === 'string' && version) fxLabel = `devops-assistant v${version}`
  } catch {
    // keep the name alone
  }
}

// ---------- small helpers ----------

/** @param {unknown} o @param {string[]} path @returns {unknown} */
function dig(o, ...path) {
  for (const p of path) {
    if (o === null || typeof o !== 'object') return undefined
    o = /** @type {Record<string, unknown>} */ (o)[p]
  }
  return o
}
/** @param {unknown} o @param {string[]} p */
const str = (o, ...p) => {
  const v = dig(o, ...p)
  return typeof v === 'string' ? v : ''
}
/** @param {unknown} o @param {string[]} p */
const num = (o, ...p) => {
  const v = dig(o, ...p)
  return typeof v === 'number' ? v : 0
}
/** @param {unknown} v @returns {unknown[]} */
const list = v => (Array.isArray(v) ? v : [])
/** @param {unknown} v @returns {Record<string, string>} */
function strMap(v) {
  /** @type {Record<string, string>} */
  const out = {}
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
  return out
}
/** @param {unknown} err */
const msg = err => (err instanceof Error ? err.message : String(err))
/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
/** @param {string} iso */
const shortTime = iso => (iso ? iso.slice(5, 19).replace('T', ' ') : '              ')
/** @param {string} kind */
const short = kind => SHORT[kind] ?? kind.toLowerCase()

/** @param {K8sData} d @param {string | null} ctx */
const tierOf = (d, ctx) => d.contexts.find(c => c.name === ctx)?.tier ?? 'prod'
/** @param {K8sData} d @param {string | null} ctx */
const grantsFor = (d, ctx) => d.grants.filter(g => g.context === ctx)
/** @param {K8sData} d @param {string | null} ctx */
function lockText(d, ctx) {
  const n = grantsFor(d, ctx).length
  return n > 0 ? `UNLOCKED x${n}` : 'LOCKED'
}

/**
 * @param {K8sTab} tab @param {string} parent @param {string} seg
 * @param {Partial<K8sNode>} fields @returns {K8sNode}
 */
function mk(tab, parent, seg, fields) {
  return { id: parent + '/' + seg, parent, tab, label: '', status: '', kind: 'Info', ns: '', name: '', detail: [], lazy: false, ...fields }
}

// ---------- k8sh MCP ----------

/** @param {Engine} $ */
async function server($) {
  if (serverName) return serverName
  const r = await $.mcp.connect('k8sh')
  if (!r.isConnected) throw new Error(`k8sh MCP server not connected: ${r.message} (check /mcp for plugin:devops-assistant:k8sh)`)
  serverName = r.server
  return serverName
}

/** @param {Engine} $ @param {string} tool @param {Record<string, unknown>} args */
async function call($, tool, args) {
  /** @type {import('claude-code').McpToolResult} */
  let r
  try {
    r = await $.mcp.call(await server($), tool, args)
  } catch (err) {
    serverName = null
    throw err
  }
  const text = list(r.content)
    .map(b => (str(b, 'type') === 'text' ? str(b, 'text') : ''))
    .join('\n')
  if (r.isError) throw new Error(text || `${tool} failed`)
  return text
}

/** @param {Engine} $ @param {string} tool @param {Record<string, unknown>} args @returns {Promise<unknown>} */
async function callJSON($, tool, args) {
  const text = await call($, tool, args)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${tool}: unexpected output`)
  }
}

/** @param {Engine} $ @returns {Promise<K8sContext[]>} */
async function loadContexts($) {
  return list(await callJSON($, 'k8s_contexts', {})).map(c => ({
    name: str(c, 'name'),
    tier: str(c, 'tier') || 'prod',
    current: dig(c, 'current') === true,
  }))
}

/** @param {Engine} $ @returns {Promise<K8sGrant[]>} */
async function loadGrants($) {
  return list(dig(await callJSON($, 'lock_status', {}), 'grants')).map(g => ({
    context: str(g, 'Context'),
    namespace: str(g, 'Namespace'),
    action: str(g, 'Action'),
    target: str(g, 'Target'),
    expiresIn: str(g, 'ExpiresIn'),
  }))
}

// ---------- loaders: each returns the nodes under one parent, in order ----------

/** @param {Engine} $ @param {string} ctx @returns {Promise<K8sNode[]>} */
async function loadNamespaces($, ctx) {
  const j = await callJSON($, 'k8s_get', { kind: 'namespaces', context: ctx })
  return list(dig(j, 'items')).map(it => {
    const name = str(it, 'metadata', 'name')
    const phase = str(it, 'status', 'phase')
    return mk('cluster', 'cluster', 'ns:' + name, {
      label: name,
      status: phase === 'Active' ? 'ok' : 'warn',
      kind: 'Namespace',
      ns: name,
      name,
      lazy: true,
      detail: [`Namespace ${name}`, `phase: ${phase}`, `created: ${str(it, 'metadata', 'creationTimestamp')}`],
    })
  })
}

/** @param {unknown} o */
function conditions(o) {
  return list(dig(o, 'status', 'conditions')).map(c => {
    const reason = str(c, 'reason')
    return `condition ${str(c, 'type')}=${str(c, 'status')}${reason ? ` (${reason})` : ''}`
  })
}

/** @param {unknown} p @param {string} ns @param {string} parent @returns {K8sNode[]} */
function podNodes(p, ns, parent) {
  const name = str(p, 'metadata', 'name')
  const phase = str(p, 'status', 'phase')
  const id = parent + '/pod:' + name
  /** @type {K8sStatus} */
  let st = 'ok'
  let restarts = 0
  let reason = ''
  /** @type {K8sNode[]} */
  const kids = []
  for (const cs of list(dig(p, 'status', 'containerStatuses'))) {
    /** @type {K8sStatus} */
    let cst = 'ok'
    const cname = str(cs, 'name')
    const r = num(cs, 'restartCount')
    restarts += r
    let state = 'running'
    const waiting = str(cs, 'state', 'waiting', 'reason')
    const terminated = str(cs, 'state', 'terminated', 'reason')
    if (waiting) {
      state = waiting
      cst = 'err'
      reason = waiting
    } else if (terminated) {
      state = 'terminated: ' + terminated
      if (terminated !== 'Completed') cst = 'err'
    }
    if (dig(cs, 'ready') !== true && cst === 'ok' && phase === 'Running') cst = 'warn'
    const last = str(cs, 'lastState', 'terminated', 'reason')
    if (last === 'OOMKilled') {
      cst = 'err'
      reason = 'OOMKilled'
    }
    if (cst === 'err' || (cst === 'warn' && st === 'ok')) st = cst
    const det = [`Container ${cname} in pod ${ns}/${name}`, `image: ${str(cs, 'image')}`, `state: ${state}`, `restarts: ${r}`]
    if (last) det.push(`last termination: ${last}`)
    kids.push(mk('cluster', id, 'c:' + cname, { label: `${cname}  ${state}  r:${r}`, status: cst, kind: 'Container', ns, name: cname, pod: name, detail: det }))
  }
  if (phase === 'Pending') st = 'warn'
  if (phase === 'Failed' || phase === 'Unknown') st = 'err'
  if (phase === 'Succeeded') st = ''
  let label = `pod/${name}  ${phase}`
  if (reason) label += ' ' + reason
  if (restarts > 0) label += ` r:${restarts}`
  const containers = list(dig(p, 'spec', 'containers')).map(c => str(c, 'name'))
  const pod = mk('cluster', parent, 'pod:' + name, {
    label,
    status: st,
    kind: 'Pod',
    ns,
    name,
    containers,
    detail: [`Pod ${ns}/${name}`, `phase: ${phase}`, `node: ${str(p, 'spec', 'nodeName')}`, `restarts: ${restarts}`, ...conditions(p)],
  })
  return [pod, ...kids]
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} nsNode @returns {Promise<K8sNode[]>} */
async function loadWorkloads($, ctx, nsNode) {
  const ns = nsNode.name
  const [w, p] = await Promise.all([
    callJSON($, 'k8s_get', { kind: 'deployments,statefulsets,daemonsets', namespace: ns, context: ctx }),
    callJSON($, 'k8s_get', { kind: 'pods', namespace: ns, context: ctx }),
  ])
  const pods = list(dig(p, 'items')).map(raw => ({ raw, labels: strMap(dig(raw, 'metadata', 'labels')), used: false }))
  /** @type {K8sNode[]} */
  const out = []
  for (const it of list(dig(w, 'items'))) {
    const kind = str(it, 'kind')
    const name = str(it, 'metadata', 'name')
    const want = kind === 'DaemonSet' ? num(it, 'status', 'desiredNumberScheduled') : num(it, 'spec', 'replicas')
    const ready = kind === 'DaemonSet' ? num(it, 'status', 'numberReady') : num(it, 'status', 'readyReplicas')
    /** @type {K8sStatus} */
    const st = ready >= want ? 'ok' : ready === 0 && want > 0 ? 'err' : 'warn'
    const images = list(dig(it, 'spec', 'template', 'spec', 'containers')).map(c => `image: ${str(c, 'image')}`)
    const wn = mk('cluster', nsNode.id, `${kind}:${name}`, {
      label: `${short(kind)}/${name}  ${ready}/${want}`,
      status: st,
      kind,
      ns,
      name,
      detail: [`${kind} ${ns}/${name}`, `ready: ${ready}/${want}`, ...images, ...conditions(it)],
    })
    out.push(wn)
    const sel = strMap(dig(it, 'spec', 'selector', 'matchLabels'))
    const keys = Object.keys(sel)
    if (keys.length === 0) continue
    for (const pi of pods) {
      if (!pi.used && keys.every(k => pi.labels[k] === sel[k])) {
        pi.used = true
        out.push(...podNodes(pi.raw, ns, wn.id))
      }
    }
  }
  for (const pi of pods) if (!pi.used) out.push(...podNodes(pi.raw, ns, nsNode.id))
  if (out.length === 0) out.push(mk('cluster', nsNode.id, 'empty', { label: '(empty)' }))
  return out
}

/** @param {{ sync: string, health: string }} a */
const appRank = a => (a.health === 'Degraded' || a.health === 'Missing' ? 2 : a.sync !== 'Synced' || a.health !== 'Healthy' ? 1 : 0)

/** @param {Engine} $ @param {string} ctx @returns {Promise<K8sNode[]>} */
async function loadApps($, ctx) {
  /** @type {unknown[]} */
  let raw
  try {
    raw = list(await callJSON($, 'argo_apps', { context: ctx }))
  } catch (err) {
    if (/doesn't have a resource type|NotFound|not found|could not find the requested resource/i.test(msg(err))) {
      return [mk('argo', 'argo', 'none', { label: 'Argo CD not installed in this context' })]
    }
    throw err
  }
  if (raw.length === 0) return [mk('argo', 'argo', 'none', { label: '(no Argo CD applications)' })]
  const apps = raw.map(a => ({
    name: str(a, 'name'),
    project: str(a, 'project'),
    sync: str(a, 'sync'),
    health: str(a, 'health'),
    revision: str(a, 'revision'),
    repo: str(a, 'repo'),
    path: str(a, 'path'),
    dest: `${str(a, 'destServer')} / ${str(a, 'destNamespace')}`,
    autoSync: dig(a, 'autoSync') === true,
    autoPrune: dig(a, 'autoPrune') === true,
    op: str(a, 'lastOperation'),
  }))
  apps.sort((x, y) => appRank(y) - appRank(x) || x.name.localeCompare(y.name))
  return apps.map(a =>
    mk('argo', 'argo', 'app:' + a.name, {
      label: `${a.name}  ${a.sync}/${a.health}`,
      status: a.health === 'Degraded' || a.health === 'Missing' ? 'err' : a.sync !== 'Synced' || a.health !== 'Healthy' ? 'warn' : 'ok',
      kind: 'Application',
      ns: 'argocd',
      name: a.name,
      lazy: true,
      detail: [
        `Application ${a.name}`,
        `project: ${a.project}`,
        `sync: ${a.sync}`,
        `health: ${a.health}`,
        `revision: ${a.revision}`,
        `repo: ${a.repo}`,
        `path: ${a.path}`,
        `destination: ${a.dest}`,
        `auto-sync: ${a.autoSync}  auto-prune: ${a.autoPrune}`,
        `last operation: ${a.op}`,
      ],
    }),
  )
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} app @returns {Promise<K8sNode[]>} */
async function loadAppTree($, ctx, app) {
  const j = await callJSON($, 'argo_app_tree', { name: app.name, context: ctx })
  const out = list(dig(j, 'resources')).map(r => {
    const kind = str(r, 'kind')
    const name = str(r, 'name')
    const ns = str(r, 'namespace')
    const sync = str(r, 'sync')
    const health = str(r, 'health')
    return mk('argo', app.id, `${kind}:${ns}:${name}`, {
      label: `${kind}/${name}  ${sync}${health ? '/' + health : ''}`,
      status: health === 'Degraded' || health === 'Missing' ? 'err' : sync !== 'Synced' ? 'warn' : 'ok',
      kind,
      ns,
      name,
      detail: [`${kind} ${ns}/${name}`, `sync: ${sync}`, `health: ${health}`, str(r, 'message')].filter(Boolean),
    })
  })
  return out.length > 0 ? out : [mk('argo', app.id, 'empty', { label: '(no resources)' })]
}

/** @param {Engine} $ @param {string} ctx @returns {Promise<K8sNode[]>} */
async function loadRCA($, ctx) {
  const r = await callJSON($, 'rca_collect', { context: ctx })
  /** @type {K8sNode[]} */
  const out = list(dig(r, 'findings')).map((f, i) => {
    const sev = num(f, 'severity')
    const object = str(f, 'object')
    const signal = str(f, 'signal')
    return mk('rca', 'rca', 'f:' + i, {
      label: `[${sev}] ${signal}  ${object}`,
      status: sev >= 8 ? 'err' : 'warn',
      kind: 'Finding',
      name: object,
      detail: [`Finding: ${signal}`, `object: ${object}`, `severity: ${sev}`, '', str(f, 'detail')],
    })
  })
  if (out.length === 0) out.push(mk('rca', 'rca', 'clean', { label: 'no problem signals in pods', status: 'ok' }))
  const warnings = list(dig(r, 'recentWarnings'))
  if (warnings.length > 0) {
    const w = mk('rca', 'rca', 'warnings', { label: `recent warnings (${warnings.length})`, status: 'warn' })
    out.push(w)
    warnings.forEach((e, i) => {
      const object = str(e, 'object')
      const parts = object.split('/')
      out.push(
        mk('rca', w.id, 'e:' + i, {
          label: `${str(e, 'reason')}  ${object}`,
          status: 'warn',
          kind: 'Event',
          ns: parts.length === 3 ? parts[0] : '',
          name: object,
          detail: [`Event ${str(e, 'reason')}`, `object: ${object}`, `last: ${str(e, 'last')}`, `count: ${num(e, 'count')}`, '', str(e, 'message')],
        }),
      )
    })
  }
  if (str(r, 'hint')) out.push(mk('rca', 'rca', 'hint', { label: 'hint: ' + str(r, 'hint') }))
  return out
}

/** @param {Engine} $ @param {string} ctx @returns {Promise<K8sNode[]>} */
async function loadLock($, ctx) {
  const [contexts, grants] = await Promise.all([loadContexts($), loadGrants($)])
  await update($, data, d => ({ ...d, contexts, grants }))
  const mine = grants.filter(g => g.context === ctx)
  /** @type {K8sNode[]} */
  const out = [
    mk('lock', 'lock', 'state', {
      label: mine.length > 0 ? `UNLOCKED x${mine.length} in ${ctx}` : `LOCKED in ${ctx}`,
      status: mine.length > 0 ? 'warn' : 'ok',
      kind: 'Lock',
      detail: [
        'Destructive actions are locked by default.',
        'A grant unlocks ONE action on ONE kind/name in one context, for at most 15 minutes,',
        'and is consumed on use. Only you can issue one: Unlock… on a pod or workload here,',
        'or `k8sh unlock` in your own terminal. Every grant and use is in the audit log.',
      ],
    }),
    mk('lock', 'lock', 'grants', { label: `active grants (${grants.length})`, kind: 'Info' }),
  ]
  grants.forEach((g, i) =>
    out.push(
      mk('lock', 'lock', 'g:' + i, {
        label: `  ${g.action} ${g.target}  ${g.context}/${g.namespace || '-'}  ${g.expiresIn}`,
        status: 'warn',
        kind: 'Grant',
        ns: g.namespace,
        name: g.target,
        detail: [`Grant: ${g.action} ${g.target}`, `context: ${g.context}`, `namespace: ${g.namespace || '-'}`, `expires in: ${g.expiresIn}`, 'single use'],
      }),
    ),
  )
  out.push(mk('lock', 'lock', 'contexts', { label: `contexts (${contexts.length})`, kind: 'Info' }))
  for (const c of contexts) {
    out.push(
      mk('lock', 'lock', 'c:' + c.name, {
        label: `  ${c.name} [${c.tier}]${c.current ? '  (kubectl current)' : ''}`,
        status: c.tier === 'prod' ? 'warn' : 'ok',
        kind: 'Context',
        name: c.name,
        detail: [`Context ${c.name}`, `tier: ${c.tier}${c.tier === 'prod' ? ' (unknown contexts count as prod)' : ''}`, c.current ? 'kubectl current context' : ''],
      }),
    )
  }
  return out
}

/** @param {Engine} $ @param {K8sTab} tab @param {string} ctx @returns {Promise<K8sNode[]>} */
function loadRoots($, tab, ctx) {
  switch (tab) {
    case 'argo':
      return loadApps($, ctx)
    case 'rca':
      return loadRCA($, ctx)
    case 'lock':
      return loadLock($, ctx)
    default:
      return loadNamespaces($, ctx)
  }
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} n */
function loadKidsOf($, ctx, n) {
  return n.kind === 'Application' ? loadAppTree($, ctx, n) : loadWorkloads($, ctx, n)
}

// ---------- state updates ----------

/**
 * Puts `nodes` under `prefix` (a tab id or a node id), dropping what was there.
 * @param {K8sData} d @param {string} prefix @param {K8sNode[]} nodes @returns {K8sData}
 */
function replaceUnder(d, prefix, nodes) {
  const under = prefix + '/'
  /** @type {Record<string, K8sNode>} */
  const keep = {}
  for (const [id, n] of Object.entries(d.nodes)) if (!id.startsWith(under)) keep[id] = n
  /** @type {Record<string, string[]>} */
  const children = {}
  for (const [id, ids] of Object.entries(d.children)) if (id !== prefix && !id.startsWith(under)) children[id] = ids
  children[prefix] = []
  for (const n of nodes) {
    keep[n.id] = n
    ;(children[n.parent] ??= []).push(n.id)
  }
  /** @type {Record<string, string>} */
  const errors = {}
  for (const [id, e] of Object.entries(d.errors)) if (id !== prefix && !id.startsWith(under)) errors[id] = e
  return { ...d, nodes: keep, children, errors }
}

/** @param {Engine} $ @param {string} id @param {string} text */
async function setError($, id, text) {
  await update($, data, d => ({ ...d, errors: { ...d.errors, [id]: text } }))
}

/** @param {Engine} $ @param {string} text @param {boolean} [isError] */
async function notify($, text, isError = false) {
  await update($, view, v => ({ ...v, notice: { text, isError } }))
}

/**
 * @template T
 * @param {Engine} $ @param {boolean} quiet @param {() => Promise<T>} fn
 */
async function busy($, quiet, fn) {
  if (!quiet) await update($, view, v => ({ ...v, busy: v.busy + 1 }))
  try {
    return await fn()
  } finally {
    if (!quiet) await update($, view, v => ({ ...v, busy: Math.max(0, v.busy - 1) }))
  }
}

/** @param {Engine} $ */
async function syncStatus($) {
  const v = await read($, view)
  const d = await read($, data)
  if (v.context) $.ui.status(`k8s ${v.context} [${tierOf(d, v.context)}] ${lockText(d, v.context)}`)
}

/** Loads the visible tab's top level, then every expanded lazy node under it. @param {Engine} $ @param {boolean} quiet */
async function refreshTab($, quiet) {
  const { tab, context: ctx } = await read($, view)
  if (!ctx) return
  await busy($, quiet, async () => {
    try {
      const roots = await loadRoots($, tab, ctx)
      if ((await read($, view)).context !== ctx) return
      await update($, data, d => ({ ...replaceUnder(d, tab, roots), loadedFor: ctx }))
    } catch (err) {
      await setError($, tab, msg(err))
      return
    }
    const v = await read($, view)
    const d = await read($, data)
    const lazy = v.expanded.map(id => d.nodes[id]).filter(n => n && n.tab === tab && n.lazy)
    await Promise.all(lazy.map(n => loadKids($, ctx, n)))
  })
  await noticeProblems($, ctx)
  if (tab === 'lock') await syncStatus($)
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} n */
async function loadKids($, ctx, n) {
  try {
    const kids = await loadKidsOf($, ctx, n)
    if ((await read($, view)).context !== ctx) return
    await update($, data, d => (d.nodes[n.id] ? replaceUnder(d, n.id, kids) : d))
  } catch (err) {
    await setError($, n.id, msg(err))
  }
}

/** Contexts and grants, the context to show, then the visible tab. @param {Engine} $ @param {boolean} quiet */
async function refreshAll($, quiet) {
  await busy($, quiet, async () => {
    /** @type {K8sContext[]} */
    let contexts
    /** @type {K8sGrant[]} */
    let grants
    try {
      ;[contexts, grants] = await Promise.all([loadContexts($), loadGrants($)])
    } catch (err) {
      await setError($, 'top', msg(err))
      return
    }
    await update($, data, d => {
      const { top: _, ...errors } = d.errors
      return { ...d, contexts, grants, errors }
    })
    await update($, view, v => {
      if (v.context && contexts.some(c => c.name === v.context)) return v
      const ctx = contexts.find(c => c.current)?.name ?? contexts[0]?.name ?? null
      return { ...v, context: ctx, expanded: [], selected: null, detail: null, pages: {}, unlock: null }
    })
    const ctx = (await read($, view)).context
    await update($, data, d => (d.loadedFor === ctx ? d : { ...d, nodes: {}, children: {}, errors: {}, loadedFor: ctx }))
    await syncStatus($)
    await refreshTab($, true)
  })
}

/** @param {Engine} $ */
async function isOpen($) {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

/** @param {Engine} $ */
function startTimer($) {
  if (timer) return
  timer = $.clock.every(REFRESH_MS, () => {
    void tick($)
  })
  fxTimer ??= $.clock.every(FRAME_MS, () => {
    void fxTick($)
  })
}

function stopTimer() {
  timer?.cancel()
  timer = null
  soon?.cancel()
  soon = null
  fxTimer?.cancel()
  fxTimer = null
  fxSize = null
  hush()
}

/** Repaints the backdrop in place, without a redraw of the pane; skips a frame that would not change. @param {Engine} $ */
async function fxTick($) {
  fxFrame += 1
  const size = fxSize
  if (!size || fxBusy) return
  if (fxMiss > 2 && fxFrame % 12 !== 0) return
  const key = backdropKey(size.cols, size.rows, fxFrame)
  if (key === fxLastKey && fxMiss === 0) return
  fxBusy = true
  try {
    const r = await $.ui.blit({ requestId: PANE, key: FX_KEY, columns: size.cols, rows: size.rows, cells: backdropCells(size.cols, size.rows, fxFrame) })
    const denied = Boolean(r && 'deny' in r && r.deny)
    fxMiss = denied ? fxMiss + 1 : 0
    if (!denied) fxLastKey = key
  } catch {
    fxMiss += 1
  } finally {
    fxBusy = false
  }
}

/** What a frame shows, as a key: equal keys draw equal cells. @param {number} cols @param {number} rows @param {number} f */
function backdropKey(cols, rows, f) {
  if (fxLook === 'infinity') return `i:${cols}x${rows}:${f}`
  const s = steveState(f)
  return `s:${cols}x${rows}:${s.pose}:${s.listening ? Math.floor(f / 3) % 3 : '-'}:${s.bubble ?? ''}:${fxLabel}`
}

/** @param {number} cols @param {number} rows @param {number} f */
function backdropCells(cols, rows, f) {
  return fxLook === 'infinity' ? infinityCells(cols, rows, f, fxLabel) : steveCells(cols, rows, f, steveState(f))
}

// ---------- Steve ----------
//
// Steve listens while the person types or dictates (sound rings by his
// headphones), thinks while Claude works (a bubble says which tool), talks
// when a turn ends (the answer's first sentence, redacted), facepalms when a
// new problem shows up in the pane, and grins at a grant. With voice on he
// says his lines aloud (macOS `say`); his mouth moves until the line ends.

/** @typedef {import('./steve.js').Pose} Pose */

// From the plugin's settings (/config): his voice and whether he swears.
// 'auto' takes the most natural English voice installed: a downloaded
// Premium one, then an Enhanced one (whatever Apple names them), else Rocko.
const DEFAULT_VOICE = 'Rocko (English (US))'
let voiceSetting = 'auto'
let voiceName = DEFAULT_VOICE
let salty = true

/**
 * The voice for 'auto', from what `say -v '?'` lists here.
 * @param {string} listing `say -v '?'` output: "<name>  <locale>  # <sample>" per line
 */
export function autoVoice(listing) {
  const english = listing
    .split('\n')
    .map(l => /^(.+?)\s+(en_[A-Z]{2})\s+#/.exec(l))
    .filter(m => m !== null)
    .map(m => /** @type {RegExpExecArray} */ (m)[1].trim())
  return english.find(n => /\(Premium\)/.test(n)) ?? english.find(n => /\(Enhanced\)/.test(n)) ?? DEFAULT_VOICE
}

/** @param {Engine} $ */
async function pickVoice($) {
  if (voiceSetting !== 'auto') {
    voiceName = voiceSetting
    return
  }
  try {
    const r = await $.process.run(['say', '-v', '?'], { timeoutMs: 5000 })
    voiceName = autoVoice(r.stdout)
  } catch {
    voiceName = DEFAULT_VOICE
  }
}
/** the model call reacting to the last answer, cut by the next @type {AbortController | null} */
let reacting = null

/** frames for ms at FRAME_MS @param {number} ms */
const F = ms => Math.round(ms / FRAME_MS)
/** @type {Pose[]} the mouth while talking: open, half, shut, unevenly */
const TALK = ['talk2', 'talk1', 'idle', 'talk1', 'talk2', 'talk2', 'talk1', 'idle', 'talk1', 'talk2', 'idle', 'idle']

const steve = {
  thinking: false,
  listenUntil: 0,
  talkUntil: 0,
  speaking: false,
  bubble: '',
  bubbleUntil: 0,
  /** @type {Pose | null} */
  mood: null,
  moodUntil: 0,
  /** problems already seen, by node id, per context; null before the first load */
  /** @type {Set<string> | null} */
  seen: null,
  seenFor: '',
  /** @type {AbortController | null} */
  hush: null,
}

/** @param {number} f @returns {import('./steve.js').SteveState} */
function steveState(f) {
  /** @type {Pose} */
  let pose
  if (steve.mood && f < steve.moodUntil) pose = steve.mood
  else if (steve.speaking || f < steve.talkUntil) pose = TALK[f % TALK.length]
  else if (steve.thinking) pose = f % 40 < 2 ? 'blink' : 'think'
  else pose = f % 52 < 2 ? 'blink' : 'idle'
  let bubble = f < steve.bubbleUntil ? steve.bubble : ''
  if (!bubble && steve.thinking) bubble = ['·', '· ·', '· · ·'][Math.floor(f / 4) % 3]
  return { pose, bubble, listening: f < steve.listenUntil && !steve.thinking, label: fxLabel }
}

/** Plain, one line, cut: what a bubble or a voice may say. @param {string} text */
function sayable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * Steve's take on an answer: one grumpy line from a fast model, given the
 * answer redacted; a canned line when the model has none.
 * @param {Engine} $ @param {string} answer
 */
async function react($, answer) {
  reacting?.abort()
  const stop = typeof AbortController === 'function' ? new AbortController() : null
  reacting = stop
  try {
    const text = await $.session.redact(answer.replace(/```[\s\S]*?```/g, ' [code] ').slice(0, 1500))
    const r = await $.model.complete(
      { model: 'haiku', system: persona(salty), prompt: `What the assistant just said:\n\n${text}`, maxTokens: 60, effort: 'low', timeoutMs: 8000 },
      stop ? { signal: stop.signal } : undefined,
    )
    if (reacting !== stop) return null
    const said = r.isAnswered ? sayable(r.text.replace(/^["“']|["”']$/g, '')).split(/(?<=[.!?])\s/).slice(0, 2).join(' ') : ''
    return said || steveLine('done', salty)
  } catch {
    return reacting === stop ? steveLine('done', salty) : null
  } finally {
    if (reacting === stop) reacting = null
  }
}

/**
 * Steve says a line: a bubble, his mouth moving, and aloud when voice is on.
 * @param {Engine} $ @param {string} text
 * @param {{ mood?: Pose, moodMs?: number, aloud?: boolean }} [opts]
 */
async function say($, text, opts = {}) {
  let line = sayable(text)
  if (!line) return
  try {
    line = await $.session.redact(line)
  } catch {
    // keep the line as it is: it came from the pane or the answer
  }
  const f = fxFrame
  const talk = Math.min(F(6000), Math.max(F(1200), Math.round((line.length * 60) / FRAME_MS)))
  const mood = opts.mood ? F(opts.moodMs ?? 1500) : 0
  steve.bubble = line
  steve.talkUntil = f + mood + talk
  steve.bubbleUntil = f + mood + talk + F(4000)
  steve.mood = opts.mood ?? null
  steve.moodUntil = f + mood
  if (fxVoice && fxLook === 'steve' && opts.aloud !== false && fxTimer) void speak($, line)
}

/** @param {Engine} $ @param {string} line */
async function speak($, line) {
  steve.hush?.abort()
  const hush = typeof AbortController === 'function' ? new AbortController() : null
  steve.hush = hush
  steve.speaking = true
  try {
    try {
      await $.audio.speak(line, { voice: voiceName, ...(hush ? { signal: hush.signal } : {}) })
    } catch (err) {
      // the chosen voice is not installed here: the system's default voice
      if (hush?.signal.aborted) throw err
      await $.audio.speak(line, hush ? { signal: hush.signal } : undefined)
    }
  } catch {
    // no synthesizer, or cut off by the next line
  } finally {
    if (steve.hush === hush) {
      steve.speaking = false
      steve.hush = null
    }
  }
}

function hush() {
  steve.hush?.abort()
  steve.hush = null
  steve.speaking = false
}

/** What Claude is doing, from the tool it calls; names a kind, never arguments' values. @param {Record<string, unknown>} e */
function toolLine(e) {
  return steveTool(String(e.tool), typeof e.kind === 'string' ? e.kind.split(',')[0] : '', TOOL_PREFIX)
}

/** After a refresh: a facepalm and a line for a problem the pane had not shown before. @param {Engine} $ @param {string} ctx */
async function noticeProblems($, ctx) {
  const d = await read($, data)
  const errs = Object.values(d.nodes).filter(n => n.status === 'err')
  if (steve.seenFor !== ctx || !steve.seen) {
    steve.seen = new Set(errs.map(n => n.id))
    steve.seenFor = ctx
    return
  }
  const fresh = errs.filter(n => !steve.seen?.has(n.id))
  for (const n of errs) steve.seen.add(n.id)
  if (fresh.length === 0 || !fxTimer || fxLook !== 'steve') return
  const x = crumb(fresh[0])
  await say($, fresh.length === 1 ? steveLine('broke', salty, { x }) : steveLine('brokeMany', salty, { x, n: fresh.length - 1 }), { mood: 'oops', moodMs: 2000 })
}

/** The light refresh: the visible tab and the lock, only while the pane is open. @param {Engine} $ */
async function tick($) {
  if (ticking) return
  ticking = true
  try {
    if (!(await isOpen($))) return stopTimer()
    const grants = await loadGrants($).catch(() => null)
    if (grants) {
      await update($, data, d => ({ ...d, grants }))
      await syncStatus($)
    }
    await refreshTab($, true)
  } finally {
    ticking = false
  }
}

// ---------- navigation ----------

/** @param {string[]} expanded @param {string} id */
const collapse = (expanded, id) => expanded.filter(x => x !== id && !x.startsWith(id + '/'))

/** @param {K8sData} d @param {K8sNode} n */
const hasKids = (d, n) => n.lazy || (d.children[n.id]?.length ?? 0) > 0

/** @param {Engine} $ @param {string} id */
async function pressRow($, id) {
  const v = await read($, view)
  if (v.selected !== id) {
    await update($, view, w => ({ ...w, selected: id, detail: null, unlock: null, notice: null }))
    return
  }
  const d = await read($, data)
  const n = d.nodes[id]
  if (!n || !hasKids(d, n)) return
  if (v.expanded.includes(id)) {
    await update($, view, w => ({ ...w, expanded: collapse(w.expanded, id) }))
    return
  }
  await update($, view, w => ({ ...w, expanded: [...w.expanded, id] }))
  if (n.lazy && !d.children[id] && v.context) await busy($, false, () => loadKids($, /** @type {string} */ (v.context), n))
}

/** @param {Engine} $ */
async function goTop($) {
  await update($, view, v => ({ ...v, expanded: [], selected: null, detail: null, pages: {}, unlock: null, notice: null }))
}

/** @param {Engine} $ */
async function goBack($) {
  const v = await read($, view)
  if (v.unlock) return update($, view, w => ({ ...w, unlock: null }))
  if (v.detail) return update($, view, w => ({ ...w, detail: null }))
  const d = await read($, data)
  const n = v.selected ? d.nodes[v.selected] : undefined
  if (!n) return
  const parent = d.nodes[n.parent]
  await update($, view, w => ({
    ...w,
    expanded: parent ? collapse(w.expanded, parent.id) : collapse(w.expanded, n.id),
    selected: parent ? parent.id : null,
    notice: null,
  }))
}

/** @param {Engine} $ @param {string} id */
async function jumpTo($, id) {
  await update($, view, v => ({ ...v, selected: id, expanded: collapse(v.expanded, id).concat(v.expanded.includes(id) ? [id] : []), detail: null, unlock: null }))
}

/** @param {Engine} $ @param {K8sTab} tab */
async function switchTab($, tab) {
  await update($, view, v => ({ ...v, tab, selected: null, detail: null, unlock: null, notice: null }))
  await refreshTab($, false)
}

/** @param {Engine} $ @param {string} ctx */
async function switchContext($, ctx) {
  await update($, view, v => ({ ...v, context: ctx, expanded: [], selected: null, detail: null, pages: {}, unlock: null, notice: null }))
  await update($, data, d => ({ ...d, nodes: {}, children: {}, errors: {}, loadedFor: ctx }))
  await syncStatus($)
  await refreshTab($, false)
}

// ---------- actions on the selected node ----------

/** @param {K8sNode} n */
const isPodish = n => n.kind === 'Pod' || n.kind === 'Container'
/** @param {K8sNode} n */
const isWorkload = n => WORKLOADS.includes(n.kind)
/** @param {K8sNode} n */
const isObject = n => n.name !== '' && !['Info', 'Finding', 'Event', 'Grant', 'Context', 'Lock'].includes(n.kind)

/** @param {K8sNode} n @returns {('delete' | 'scale-zero')[]} */
function unlockActions(n) {
  if (!n.ns || !n.name) return []
  if (n.kind === 'Pod' || n.kind === 'DaemonSet') return ['delete']
  if (n.kind === 'Deployment' || n.kind === 'StatefulSet') return ['delete', 'scale-zero']
  return []
}

/** @param {K8sNode} n */
const targetOf = n => `${n.kind.toLowerCase()}/${n.name}`

/** @param {K8sNode} n */
function objectName(n) {
  if (n.kind === 'Container') return `pod/${n.pod} container ${n.name}`
  if (n.kind === 'Namespace') return `namespace/${n.name}`
  if (n.kind === 'Application') return `application/${n.name} (Argo CD)`
  if (isObject(n)) return targetOf(n)
  return n.name || n.label
}

/** @param {string} text */
function tail(text) {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.length > DETAIL_MAX_LINES ? [`… ${lines.length - DETAIL_MAX_LINES} earlier lines not shown`, ...lines.slice(-DETAIL_MAX_LINES)].join('\n') : lines.join('\n')
}

/** @param {Engine} $ @param {string} title @param {() => Promise<string>} fn */
async function showDetail($, title, fn) {
  await update($, view, v => ({ ...v, detail: { title, text: 'loading…' }, unlock: null, notice: null }))
  let text
  try {
    text = tail((await fn()) || '(empty)')
  } catch (err) {
    text = 'error: ' + msg(err)
  }
  await update($, view, v => (v.detail?.title === title ? { ...v, detail: { title, text } } : v))
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} n @param {boolean} previous */
function logs($, ctx, n, previous) {
  const pod = n.kind === 'Pod' ? n.name : n.pod ?? ''
  /** @type {Record<string, unknown>} */
  const args = { pod, namespace: n.ns, context: ctx, tail: 200, previous }
  if (n.kind === 'Container') args.container = n.name
  return showDetail($, `${previous ? 'previous logs' : 'logs'} ${n.kind === 'Container' ? `${pod}/${n.name}` : pod}`, () => call($, 'k8s_logs', args))
}

/** @param {K8sNode} n @returns {(object: string) => boolean} */
function eventFilter(n) {
  const { ns, name, kind } = n
  if (kind === 'Namespace') return () => true
  if (kind === 'Pod') return o => o === `${ns}/Pod/${name}`
  if (kind === 'Container') return o => o === `${ns}/Pod/${n.pod}`
  if (kind === 'Application') return o => o === `argocd/Application/${name}`
  if (isWorkload(n)) return o => o === `${ns}/${kind}/${name}` || o.startsWith(`${ns}/ReplicaSet/${name}-`) || o.startsWith(`${ns}/Pod/${name}-`)
  return o => o === `${ns}/${kind}/${name}`
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} n */
function events($, ctx, n) {
  const ns = n.kind === 'Application' ? 'argocd' : n.ns
  return showDetail($, `events ${objectName(n)}`, async () => {
    const match = eventFilter(n)
    const rows = list(await callJSON($, 'k8s_events', { namespace: ns, context: ctx, warningsOnly: false })).filter(e => match(str(e, 'object')))
    if (rows.length === 0) return '(no recent events)'
    return rows
      .map(e => {
        const count = num(e, 'count')
        return `${shortTime(str(e, 'last'))} ${str(e, 'type') === 'Warning' ? '⚠' : ' '} ${str(e, 'reason')}  ${str(e, 'object')}  ${str(e, 'message')}${count > 1 ? ` (x${count})` : ''}`
      })
      .join('\n')
  })
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} n */
function describe($, ctx, n) {
  /** @type {Record<string, unknown>} */
  let args
  if (n.kind === 'Container') args = { kind: 'pod', name: n.pod, namespace: n.ns }
  else if (n.kind === 'Namespace') args = { kind: 'namespace', name: n.name }
  else if (n.kind === 'Application') args = { kind: 'applications.argoproj.io', name: n.name, namespace: 'argocd' }
  else args = { kind: n.kind, name: n.name, namespace: n.ns }
  return showDetail($, `describe ${objectName(n)}`, () => call($, 'k8s_describe', { ...args, context: ctx }))
}

/** The prompt Ask Claude sends: short, redacted, the selection and the last output. @param {Engine} $ */
async function askClaude($) {
  const v = await read($, view)
  const d = await read($, data)
  const ctx = v.context ?? '(none)'
  const n = v.selected ? d.nodes[v.selected] : undefined
  const lines = [
    'From the k8s pane: please diagnose this, read-only, following the devops-assistant rca-runbook skill.',
    `context: ${ctx} [${tierOf(d, v.context)}] (lock: ${lockText(d, v.context)})`,
  ]
  if (n) {
    if (n.ns) lines.push(`namespace: ${n.ns}`)
    lines.push(`object: ${objectName(n)}`, `status: ${n.status || 'n/a'} (${n.label.trim()})`)
    const det = n.detail.filter(Boolean).slice(0, 12)
    if (det.length > 0) lines.push('summary:', ...det.map(l => '  ' + l))
  } else {
    const tab = TABS.find(t => t.id === v.tab)?.label ?? v.tab
    const problems = (d.children[v.tab] ?? []).map(id => d.nodes[id]).filter(x => x && (x.status === 'err' || x.status === 'warn'))
    lines.push(`view: ${tab} (top level)`)
    if (problems.length > 0) lines.push('problems:', ...problems.slice(0, 15).map(x => `  ${x.status === 'err' ? '✖' : '⚠'} ${x.label.trim()}`))
    else lines.push('no problems at the top level of this view')
  }
  if (v.detail && v.detail.text !== 'loading…') {
    lines.push(`last output (${v.detail.title}, tail):`, '```', v.detail.text.split('\n').slice(-40).join('\n'), '```')
  }
  const text = await $.session.redact(cut(lines.join('\n'), 6000))
  await $.prompt.submit({ text, asUser: true })
  await notify($, 'Sent to Claude. It will answer in the chat.')
}

// ---------- Unlock… (the person's own input only) ----------

/** @param {Engine} $ @param {K8sNode} n */
async function openUnlock($, n) {
  const actions = unlockActions(n)
  if (actions.length === 0) return
  await update($, view, v => ({ ...v, unlock: { nodeId: n.id, action: actions[0] }, detail: null, notice: null }))
}

/** @param {string} iso */
function clock(iso) {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  const p = /** @param {number} x */ x => String(x).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
}

/**
 * Runs from the unlock Input's onSubmit, which only the person's typing raises.
 * @param {Engine} $ @param {string} typed
 */
async function submitUnlock($, typed) {
  const v = await read($, view)
  const d = await read($, data)
  const u = v.unlock
  const n = u ? d.nodes[u.nodeId] : undefined
  const ctx = v.context
  if (!u || !n || !ctx) return
  if (!unlockActions(n).includes(u.action)) return
  const setU = /** @param {Partial<import('../types').K8sUnlock>} patch */ patch =>
    update($, view, w => (w.unlock && w.unlock.nodeId === u.nodeId ? { ...w, unlock: { ...w.unlock, ...patch } } : w))
  if (typed !== ctx) {
    await setU({ error: `That is not "${ctx}". Nothing was unlocked.`, isBusy: false })
    await say($, steveLine('wrongName', salty), { mood: 'oops', moodMs: 1500, aloud: false })
    return
  }
  await setU({ error: undefined, isBusy: true })
  const launch = `${$.plugin.root}/bin/k8sh-launch`
  const target = targetOf(n)
  try {
    const init = await $.process.run([launch, 'ui-init'], { timeoutMs: 180000 })
    if (init.exitCode !== 0) throw new Error(init.stderr.trim() || 'k8sh ui-init failed')
    const token = (await $.fs.read(init.stdout.trim())).trim()
    const r = await $.process.run(
      [launch, 'grant-from-ui', '--context', ctx, '--namespace', n.ns, '--action', u.action, '--target', target, '--confirm', typed],
      { stdin: token + '\n', timeoutMs: 60000 },
    )
    if (r.exitCode !== 0) throw new Error(r.stderr.replace(/^k8sh:\s*/, '').trim() || 'k8sh grant-from-ui failed')
    const g = JSON.parse(r.stdout)
    const tool = u.action === 'delete' ? 'destructive_delete' : 'destructive_scale_zero'
    await update($, view, w => ({
      ...w,
      unlock: null,
      notice: {
        text: `🔓 granted ${str(g, 'id')}: ONE ${u.action} on ${target} in ${ctx}/${n.ns}, until ${clock(str(g, 'expiresAt'))}. Claude can call ${tool} once.`,
        isError: false,
      },
    }))
  } catch (err) {
    await setU({ error: msg(err), isBusy: false })
    await say($, steveLine('refused', salty), { mood: 'oops', moodMs: 1500 })
    return
  }
  await say($, steveLine('granted', salty, { x: `${u.action} ${target}` }), { mood: 'yay', moodMs: 2000 })
  const grants = await loadGrants($).catch(() => null)
  if (grants) await update($, data, x => ({ ...x, grants }))
  await syncStatus($)
  if (v.tab === 'lock') await refreshTab($, true)
}

// ---------- drawing ----------

const ICON = /** @type {Record<string, string>} */ ({ ok: '✔', warn: '⚠', err: '✖', '': '·' })
const ICON_COLOR = /** @type {Record<string, string>} */ ({ ok: 'success', warn: 'warning', err: 'error', '': 'inactive' })

const LOOK_LABEL = { steve: '☺ Steve', infinity: '∞', off: '○' }
/** @type {Record<'steve' | 'infinity' | 'off', 'steve' | 'infinity' | 'off'>} */
const NEXT_LOOK = { steve: 'infinity', infinity: 'off', off: 'steve' }

/** @param {K8sView} v @returns {'steve' | 'infinity' | 'off'} */
const lookOf = v => v.look ?? (v.fx === false ? 'off' : 'steve')

/** @param {Engine} $ */
async function cycleLook($) {
  await update($, view, w => ({ ...w, look: NEXT_LOOK[lookOf(w)] }))
}

/** @param {Engine} $ */
async function toggleVoice($) {
  const on = !(await read($, view)).voice
  await update($, view, w => ({ ...w, voice: on }))
  fxVoice = on
  if (on) {
    // a voice downloaded since the session started counts
    await pickVoice($)
    await say($, steveLine('voiceOn', salty))
  }
  else hush()
}

/** h() answers a node; a pane's tree is always an element. @param {unknown} x */
const asElement = x => /** @type {import('claude-code').RenderElement} */ (x)

/** @param {K8sNode} n */
function crumb(n) {
  if (n.kind === 'Pod') return `pod/${n.name}`
  if (isWorkload(n)) return `${short(n.kind)}/${n.name}`
  if (n.kind === 'Namespace' || n.kind === 'Application' || n.kind === 'Container') return n.name
  return cut(n.label.trim(), 24)
}

/**
 * @typedef {{ type: 'node', node: K8sNode, depth: number }
 *   | { type: 'more', parent: string, depth: number, left: number }
 *   | { type: 'less', parent: string, depth: number, left: number }
 *   | { type: 'error', parent: string, text: string, depth: number }
 *   | { type: 'loading', depth: number }} Row
 */

/** @param {K8sData} d @param {K8sView} v @returns {Row[]} */
function rowsOf(d, v) {
  /** @type {Row[]} */
  const rows = []
  /** @param {string} parent @param {number} depth */
  const walk = (parent, depth) => {
    const err = d.errors[parent]
    if (err) rows.push({ type: 'error', parent, text: err, depth })
    const kids = d.children[parent]
    if (!kids) {
      if (!err) rows.push({ type: 'loading', depth })
      return
    }
    const limit = v.pages[parent] ?? PAGE
    for (const id of kids.slice(0, limit)) {
      const n = d.nodes[id]
      if (!n) continue
      rows.push({ type: 'node', node: n, depth })
      if (v.expanded.includes(id) && hasKids(d, n)) walk(id, depth + 1)
    }
    if (kids.length > limit) rows.push({ type: 'more', parent, depth, left: kids.length - limit })
    else if (limit > PAGE) rows.push({ type: 'less', parent, depth, left: 0 })
  }
  walk(v.tab, 0)
  return rows
}

/**
 * @param {Engine} $
 * @param {import('claude-code').RenderInput<'Pane'>} e
 * @returns {Promise<import('claude-code').RenderElement>}
 */
async function draw($, e) {
  const { Box, Text, Button, Select, Input, Code } = $.ui.resolve(e)
  const v = await read($, view)
  const d = await read($, data)
  const cols = Math.max(24, e.props.bodyColumns ?? 60)
  const ctx = v.context
  const sel = v.selected ? d.nodes[v.selected] : undefined
  const locked = grantsFor(d, ctx).length === 0

  const els = $.ui.resolve(e)
  // Raster is the terminal's alone; the backdrop is drawn in the docked pane.
  const Raster = e.surface === 'terminal' && e.props.placement === 'dock' && 'Raster' in els ? els.Raster : undefined
  const look = lookOf(v)

  if (e.props.placement === 'widget') {
    const all = (d.children[v.tab] ?? []).map(id => d.nodes[id]).filter(Boolean)
    const errs = all.filter(n => n.status === 'err').length
    const warns = all.filter(n => n.status === 'warn').length
    return asElement(
      h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true }, `k8s ${ctx ?? '…'} [${tierOf(d, ctx)}] `, h(Text, { color: locked ? 'success' : 'warning' }, lockText(d, ctx))),
        h(Text, { dimColor: true }, `${errs} error · ${warns} warning`),
      ),
    )
  }

  /** @type {unknown[]} */
  const out = []

  // 1. tab row
  out.push(
    h(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 },
      ...TABS.map(t =>
        h(Button, {
          key: 'tab:' + t.id,
          label: t.label,
          hotkey: t.hotkey,
          plain: true,
          dimColor: t.id !== v.tab,
          onPress: () => switchTab($, t.id),
        }),
      ),
      v.busy > 0 ? h(Text, { dimColor: true }, 'loading…') : null,
      Raster ? h(Button, { key: 'look', label: LOOK_LABEL[look], plain: true, dimColor: look === 'off', onPress: () => cycleLook($) }) : null,
      Raster && look === 'steve' ? h(Button, { key: 'voice', label: v.voice ? '♪ voice on' : '♪ voice off', plain: true, dimColor: !v.voice, onPress: () => toggleVoice($) }) : null,
    ),
  )

  // 2. context row
  const options = d.contexts.map(c => ({ value: c.name, label: `${c.name} [${c.tier}]` }))
  out.push(
    h(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 },
      options.length > 0
        ? h(Select, { key: 'context', label: 'context ', options, value: ctx ?? undefined, onSelect: (/** @type {string} */ value) => switchContext($, value) })
        : h(Text, { dimColor: true }, d.errors.top ? 'no contexts' : 'contexts…'),
      ctx ? h(Text, { bold: true, color: locked ? 'success' : 'warning' }, lockText(d, ctx)) : null,
    ),
  )
  if (d.errors.top) out.push(h(Text, { color: 'error' }, '✖ ' + d.errors.top))

  // 3. breadcrumb
  const chain = []
  for (let n = sel; n; n = d.nodes[n.parent]) chain.unshift(n)
  const tabLabel = TABS.find(t => t.id === v.tab)?.label ?? v.tab
  /** @type {unknown[]} */
  const crumbs = [
    h(Button, { key: 'crumb:top', label: '⌂', plain: true, onPress: () => goTop($) }),
    h(Text, { dimColor: true }, ' '),
    h(Button, { key: 'crumb:tab', label: tabLabel, plain: true, dimColor: chain.length > 0, onPress: () => update($, view, w => ({ ...w, selected: null, detail: null, unlock: null })) }),
  ]
  chain.forEach((n, i) => {
    crumbs.push(h(Text, { dimColor: true }, ' › '))
    crumbs.push(h(Button, { key: 'crumb:' + n.id, label: crumb(n), plain: true, dimColor: i < chain.length - 1, onPress: () => jumpTo($, n.id) }))
  })
  out.push(h(Box, { flexDirection: 'row', flexWrap: 'wrap' }, ...crumbs))

  // 4. tree
  /** @type {unknown[]} */
  const tree = []
  for (const r of rowsOf(d, v)) {
    const pad = '  '.repeat(r.depth)
    if (r.type === 'loading') tree.push(h(Text, { dimColor: true }, pad + '  loading…'))
    else if (r.type === 'error') tree.push(h(Text, { color: 'error' }, pad + '  ✖ ' + cut(r.text, Math.max(20, cols * 3))))
    else if (r.type === 'more')
      tree.push(
        h(Button, { key: 'more:' + r.parent, label: `${pad}  more… (${r.left} more)`, plain: true, dimColor: true, onPress: () => update($, view, w => ({ ...w, pages: { ...w.pages, [r.parent]: (w.pages[r.parent] ?? PAGE) + PAGE } })) }),
      )
    else if (r.type === 'less')
      tree.push(
        h(Button, {
          key: 'less:' + r.parent,
          label: `${pad}  show first ${PAGE}`,
          plain: true,
          dimColor: true,
          onPress: () =>
            update($, view, w => {
              const { [r.parent]: _, ...pages } = w.pages
              return { ...w, pages }
            }),
        }),
      )
    else {
      const n = r.node
      const isSel = n.id === v.selected
      const arrow = hasKids(d, n) ? (v.expanded.includes(n.id) ? '▾' : '▸') : ' '
      const room = Math.max(10, cols - pad.length - 5)
      tree.push(
        h(
          Button,
          { key: 'row:' + n.id, plain: true, onPress: () => pressRow($, n.id) },
          `${pad}${arrow} `,
          h(Text, { color: ICON_COLOR[n.status] }, ICON[n.status]),
          ' ',
          h(Text, { bold: isSel, inverse: isSel }, cut(n.label, room)),
        ),
      )
    }
  }
  out.push(h(Box, { flexDirection: 'column', marginTop: 1 }, ...tree))

  // 5. detail
  out.push(h(Text, { dimColor: true }, '─'.repeat(Math.min(cols, 120))))
  if (v.unlock && sel && v.unlock.nodeId === sel.id && ctx) {
    const u = v.unlock
    const choices = unlockActions(sel)
    out.push(
      h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true, color: 'warning' }, `Unlock ONE destructive action — ${ctx} [${tierOf(d, ctx)}]`),
        h(Text, null, `target: ${targetOf(sel)} in namespace ${sel.ns}`),
        choices.length > 1
          ? h(
              Box,
              { flexDirection: 'row', columnGap: 2 },
              h(Text, null, 'action:'),
              ...choices.map(a => h(Button, { key: 'unlock-action:' + a, label: a, plain: true, dimColor: a !== u.action, onPress: () => update($, view, w => (w.unlock ? { ...w, unlock: { ...w.unlock, action: a, error: undefined } } : w)) })),
            )
          : null,
        h(Text, null, `Type the context name to allow ONE ${u.action} on ${targetOf(sel)}:`),
        u.isBusy
          ? h(Text, { dimColor: true }, 'issuing grant…')
          : h(Input, { key: 'unlock-confirm', placeholder: 'context name', submitLabel: 'unlock', autoFocus: true, onSubmit: (/** @type {string} */ typed) => submitUnlock($, typed) }),
        u.error ? h(Text, { color: 'error' }, '✖ ' + u.error) : null,
        h(Text, { dimColor: true }, 'Single use, this exact target only, expires within 15 minutes, written to the audit log.'),
        h(Button, { key: 'unlock-cancel', label: 'Cancel', onPress: () => update($, view, w => ({ ...w, unlock: null })) }),
      ),
    )
  } else if (v.detail) {
    out.push(
      h(
        Box,
        { flexDirection: 'row', columnGap: 2 },
        h(Text, { bold: true }, cut(v.detail.title, Math.max(10, cols - 12))),
        h(Button, { key: 'detail-close', label: '✕ close', plain: true, onPress: () => update($, view, w => ({ ...w, detail: null })) }),
      ),
    )
    out.push(h(Code, { source: v.detail.text, wrap: 'wrap' }))
  } else if (sel) {
    out.push(h(Box, { flexDirection: 'column' }, ...sel.detail.map(l => h(Text, { wrap: 'wrap' }, l || ' '))))
  } else {
    out.push(h(Text, { dimColor: true }, 'Press a row to select it, press it again to expand. 1-4 switch tabs.'))
  }

  // notices
  if (v.notice) out.push(h(Text, { color: v.notice.isError ? 'error' : 'success', wrap: 'wrap' }, v.notice.text))

  // 6. action row
  /** @type {unknown[]} */
  const acts = []
  const c = ctx ?? ''
  if (sel && ctx) {
    if (isPodish(sel)) {
      acts.push(
        h(Button, { key: 'act:logs', label: 'Logs', onPress: () => logs($, c, sel, false) }),
        h(Button, { key: 'act:prev', label: 'Prev logs', onPress: () => logs($, c, sel, true) }),
      )
    }
    if (isPodish(sel) || isObject(sel)) {
      acts.push(
        h(Button, { key: 'act:events', label: 'Events', onPress: () => events($, c, sel) }),
        h(Button, { key: 'act:describe', label: 'Describe', onPress: () => describe($, c, sel) }),
      )
    }
  }
  acts.push(
    h(Button, { key: 'act:ask', label: 'Ask Claude', variant: 'primary', onPress: () => askClaude($) }),
    h(Button, { key: 'act:back', label: '← Back', onPress: () => goBack($) }),
    h(Button, { key: 'act:top', label: '⌂ Top', onPress: () => goTop($) }),
    h(Button, { key: 'act:refresh', label: '⟳ Refresh', onPress: () => refreshAll($, false) }),
  )
  if (sel && ctx && unlockActions(sel).length > 0) acts.push(h(Button, { key: 'act:unlock', label: 'Unlock…', onPress: () => openUnlock($, sel) }))
  out.push(h(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, marginTop: 1 }, ...acts))

  // The backdrop (Steve or the ∞): placed first, so everything after paints
  // over it and it shows only in the cells the pane leaves blank.
  let backdrop = null
  if (e.surface === 'terminal') {
    fxLook = look
    fxVoice = v.voice === true
    if (!fxVoice || look !== 'steve') hush()
  }
  if (Raster && look !== 'off') {
    const fxCols = Math.min(512, Math.max(1, e.props.bodyColumns ?? cols))
    const fxRows = Math.min(256, Math.max(1, e.props.scroll?.bodyRows ?? 40))
    fxSize = { cols: fxCols, rows: fxRows }
    fxMiss = 0
    fxLastKey = backdropKey(fxCols, fxRows, fxFrame)
    backdrop = h(Box, { position: 'absolute', top: 0, left: 0 }, h(Raster, { key: FX_KEY, columns: fxCols, rows: fxRows, cells: backdropCells(fxCols, fxRows, fxFrame) }))
  } else if (e.surface === 'terminal') {
    fxSize = null
  }

  return asElement(h(Box, { flexDirection: 'column' }, backdrop, ...out))
}

// ---------- open / close ----------

/**
 * @param {Engine} $
 * @param {import('claude-code').CommandPresentation | undefined} presentation
 */
async function openPane($, presentation) {
  const columns = presentation ? Math.max(24, Math.floor(presentation.columns * 0.45)) : 200
  const opened = await $.ui.open({ id: PANE, title: 'k8s', focus: true, closeOnEscape: true, columns })
  // what is broken when the pane opens is the baseline: Steve speaks up only for new problems
  steve.seen = null
  steve.thinking = false
  startTimer($)
  void say($, steveLine('greet', salty), { aloud: false })
  $.clock.after(1, () => {
    void refreshAll($, false)
  })
  if (!opened.isPlaced) return `k8s pane is waiting to be placed: ${opened.reason}`
  const where = presentation?.isFullscreen === false ? 'above the prompt' : 'on the right'
  return `k8s pane open ${where}. 1-4 switch tabs, Esc or /k8s closes it.`
}

/** @param {import('claude-code').On} on @param {import('claude-code').PluginOptions} [options] */
export function register(on, options) {
  if (typeof options?.steveVoice === 'string' && options.steveVoice) voiceSetting = options.steveVoice
  if (typeof options?.steveSwearing === 'boolean') salty = options.steveSwearing

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'k8s',
      description: 'Open or close the k8s pane beside the chat (Cluster, Argo CD, RCA, Lock)',
      immediate: true,
    })
    await loadLabel($)
    void pickVoice($)
    await update($, view, v => ({ ...v, busy: 0, unlock: v.unlock ? { ...v.unlock, isBusy: false } : null }))
    if (await isOpen($)) {
      startTimer($)
      $.clock.after(1, () => {
        void refreshAll($, true)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'k8s' }, async ($, e) => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'k8s pane closed.', isTextDisplayOnly: true }
    }
    return { text: await openPane($, e.presentation), isTextDisplayOnly: true }
  })

  // /devops-assistant:ui (commands/ui.md) opens the same pane; the markdown is
  // only the fallback for a Claude Code that doesn't load mods.
  on('command.run', { command: 'devops-assistant:ui' }, async ($, e) => ({
    text: await openPane($, e.presentation),
    isTextDisplayOnly: true,
  })).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => draw($, e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) stopTimer()
    return next(e)
  }).catch(($, e, next) => next(e))

  // Steve listens while the person types or dictates into the prompt.
  on('prompt.edit', ($, e, next) => {
    if (fxTimer) steve.listenUntil = fxFrame + F(1500)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.change', ($, e, next) => {
    if (fxTimer) steve.listenUntil = fxFrame + F(1500)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A prompt sent: he stops listening (and talking) and starts thinking.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (fxTimer) {
      steve.listenUntil = 0
      steve.bubbleUntil = 0
      steve.talkUntil = 0
      steve.thinking = true
      hush()
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (fxTimer && !e.agentId) steve.thinking = true
    return next(e)
  }).catch(($, e, next) => next(e))

  // The turn's answer: Steve says its first sentence (aloud with voice on).
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (fxTimer && !e.agentId) {
        steve.thinking = false
        if (e.isAborted) await say($, steveLine('stopped', salty), { aloud: false })
        else if (e.answer && fxLook === 'steve') {
          const said = await react($, e.answer)
          if (said) await say($, said)
        }
      }
    } catch {
      // Steve is decoration: never fail the turn
    }
    return result
  })

  // After Claude uses a k8sh tool, reflect what it just looked at.
  on('tool.call', async ($, e, next) => {
    if (fxTimer && !e.agentId) {
      const line = toolLine(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (e)))
      if (line) {
        steve.thinking = true
        steve.bubble = line
        steve.bubbleUntil = fxFrame + F(3000)
      }
    }
    const result = await next(e)
    if (String(e.tool).startsWith(TOOL_PREFIX) && timer) {
      soon?.cancel()
      soon = $.clock.after(1500, () => {
        soon = null
        void tick($)
      })
    }
    return result
  }).catch(($, e, next) => next(e))
}
