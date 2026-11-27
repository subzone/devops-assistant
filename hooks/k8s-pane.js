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
/** tree rows shown while a detail (logs, describe…) or the unlock is open */
const TREE_WHILE_DETAIL = 12
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
  { id: 'fleet', label: 'Fleet', hotkey: '5' },
  { id: 'security', label: 'Security', hotkey: '6' },
  { id: 'incidents', label: 'Incidents', hotkey: '7' },
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

/** Pod health counts per namespace, per context, and when they were taken. @type {Map<string, { at: number, byNs: Map<string, { err: number, warn: number, total: number }> }>} */
const podCounts = new Map()
// The quiet 15 s refresh reuses counts this young: one all-namespaces pods
// call a minute at most, not every tick, on a big cluster.
const COUNTS_MS = 60000

/**
 * ✖/⚠ pod counts per namespace, from one all-namespaces pods call; null when
 * that call fails (the namespaces still show).
 * @param {Engine} $ @param {string} ctx @param {boolean} quiet
 */
async function namespaceCounts($, ctx, quiet) {
  const now = Date.now()
  const hit = podCounts.get(ctx)
  if (quiet && hit && now - hit.at < COUNTS_MS) return hit.byNs
  try {
    const j = await callJSON($, 'k8s_get', { kind: 'pods', allNamespaces: true, context: ctx })
    /** @type {Map<string, { err: number, warn: number, total: number }>} */
    const byNs = new Map()
    for (const p of list(dig(j, 'items'))) {
      const ns = str(p, 'metadata', 'namespace')
      const c = byNs.get(ns) ?? { err: 0, warn: 0, total: 0 }
      const st = podHealth(p, now).st
      c.total += 1
      if (st === 'err') c.err += 1
      else if (st === 'warn') c.warn += 1
      byNs.set(ns, c)
    }
    podCounts.set(ctx, { at: now, byNs })
    return byNs
  } catch {
    return hit?.byNs ?? null
  }
}

/** @param {K8sStatus} s */
const rank = s => (s === 'err' ? 2 : s === 'warn' ? 1 : 0)

// Fleet and Security read whole clusters: the quiet refresh spares them.
const SLOW_TABS = new Set(['fleet', 'security'])
const SLOW_MS = 120000
/** when a tab was last loaded, by tab|context @type {Map<string, number>} */
const loadedAt = new Map()

/** @param {Engine} $ @param {string} ctx @param {boolean} quiet @returns {Promise<K8sNode[]>} */
async function loadNamespaces($, ctx, quiet) {
  const [j, counts] = await Promise.all([callJSON($, 'k8s_get', { kind: 'namespaces', context: ctx }), namespaceCounts($, ctx, quiet)])
  const nodes = list(dig(j, 'items')).map(it => {
    const name = str(it, 'metadata', 'name')
    const phase = str(it, 'status', 'phase')
    const c = counts?.get(name)
    /** @type {K8sStatus} */
    const status = c && c.err > 0 ? 'err' : (c && c.warn > 0) || phase !== 'Active' ? 'warn' : 'ok'
    let label = name
    if (c?.err) label += `  ✖${c.err}`
    if (c?.warn) label += `${c.err ? ' ' : '  '}⚠${c.warn}`
    const detail = [`Namespace ${name}`, `phase: ${phase}`, `created: ${str(it, 'metadata', 'creationTimestamp')}`]
    if (c) detail.push(`pods: ${c.total} (${c.err} failing, ${c.warn} not ready)`)
    return mk('cluster', 'cluster', 'ns:' + name, { label, status, kind: 'Namespace', ns: name, name, lazy: true, detail, counts: c ? { err: c.err, warn: c.warn } : undefined })
  })
  // broken namespaces first, as Argo CD apps are
  return nodes.sort((x, y) => rank(y.status) - rank(x.status) || x.name.localeCompare(y.name))
}

/** @param {unknown} o */
function conditions(o) {
  return list(dig(o, 'status', 'conditions')).map(c => {
    const reason = str(c, 'reason')
    return `condition ${str(c, 'type')}=${str(c, 'status')}${reason ? ` (${reason})` : ''}`
  })
}

// Waiting reasons that mean a container is only on its way up, not broken.
const STARTING = new Set(['ContainerCreating', 'PodInitializing'])
// Within this, a past OOM kill or a failed Job run is a problem now; older,
// it is history (as k8sh's fleet and RCA see it).
const RECENT_MS = 3600e3

/** How long ago, short: 45s, 12m, 5h, 3d. @param {number} ms epoch ms @param {number} now */
function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * A pod's health, init containers included, and one line per container.
 * @param {unknown} p @param {number} now
 */
function podHealth(p, now) {
  const phase = str(p, 'status', 'phase')
  /** @type {K8sStatus} */
  let st = 'ok'
  let restarts = 0
  let lastRestart = 0
  let mainReason = ''
  let initReason = ''
  let initBroken = false
  /** @type {{ name: string, init: boolean, state: string, status: K8sStatus, restarts: number, last: string, image: string }[]} */
  const containers = []
  for (const [init, field] of /** @type {const} */ ([
    [true, 'initContainerStatuses'],
    [false, 'containerStatuses'],
  ])) {
    for (const cs of list(dig(p, 'status', field))) {
      /** @type {K8sStatus} */
      let cst = 'ok'
      const r = num(cs, 'restartCount')
      restarts += r
      let state = 'running'
      const waiting = str(cs, 'state', 'waiting', 'reason')
      const terminated = str(cs, 'state', 'terminated', 'reason')
      const exitCode = num(cs, 'state', 'terminated', 'exitCode')
      if (waiting) {
        state = waiting
        cst = STARTING.has(waiting) ? 'warn' : 'err'
        if (init) {
          initReason = 'Init:' + waiting
          initBroken ||= cst === 'err'
        } else mainReason = waiting
      } else if (terminated) {
        const done = terminated === 'Completed' || exitCode === 0
        state = done && init ? 'done' : 'terminated: ' + terminated
        if (!done) {
          cst = 'err'
          if (init) {
            initReason = 'Init:' + terminated
            initBroken = true
          }
        }
      } else if (init && dig(cs, 'state', 'running') !== undefined) {
        cst = 'warn'
        initReason ||= 'Init:Running'
      }
      if (!init && dig(cs, 'ready') !== true && cst === 'ok' && phase === 'Running') cst = 'warn'
      const last = str(cs, 'lastState', 'terminated', 'reason')
      const finished = Date.parse(str(cs, 'lastState', 'terminated', 'finishedAt'))
      if (!Number.isNaN(finished) && finished > lastRestart) lastRestart = finished
      if (last === 'OOMKilled') {
        // an old OOM kill on a ready container is history, not a problem now
        const since = now - finished
        if (dig(cs, 'ready') !== true || Number.isNaN(finished) || since <= RECENT_MS) {
          cst = 'err'
          if (!init) mainReason = 'OOMKilled'
        } else if (since <= 24 * 3600e3) {
          if (cst === 'ok') cst = 'warn'
          if (!init && !mainReason) mainReason = 'OOMKilled earlier'
        }
      }
      if (cst === 'err' || (cst === 'warn' && st === 'ok')) st = cst
      containers.push({ name: str(cs, 'name'), init, state, status: cst, restarts: r, last, image: str(cs, 'image') })
    }
  }
  if (phase === 'Pending' && st === 'ok') st = 'warn'
  if (phase === 'Unknown') st = 'err'
  if (phase === 'Failed') {
    // an evicted leftover is ⚠; a Job run that failed a while ago is history
    const ends = list(dig(p, 'status', 'containerStatuses'))
      .map(cs => Date.parse(str(cs, 'state', 'terminated', 'finishedAt')))
      .filter(t => !Number.isNaN(t))
    const old = ownerOf(p)?.kind === 'Job' && ends.length > 0 && now - Math.max(...ends) > RECENT_MS
    st = str(p, 'status', 'reason') === 'Evicted' ? 'warn' : old ? '' : 'err'
    if (str(p, 'status', 'reason') === 'Evicted') mainReason = 'Evicted'
  }
  if (phase === 'Succeeded') st = ''
  // stuck in init: say why; past it, the main containers' reason
  const reason = initBroken ? initReason : mainReason || initReason
  const started = Date.parse(str(p, 'status', 'startTime'))
  return { phase, st, reason, restarts, lastRestart, started: Number.isNaN(started) ? 0 : started, containers }
}

/** @param {unknown} p @param {string} ns @param {string} parent @param {number} now @returns {K8sNode[]} */
function podNodes(p, ns, parent, now) {
  const name = str(p, 'metadata', 'name')
  const id = parent + '/pod:' + name
  const hl = podHealth(p, now)
  const kids = hl.containers.map(c => {
    const det = [`${c.init ? 'Init container' : 'Container'} ${c.name} in pod ${ns}/${name}`, `image: ${c.image}`, `state: ${c.state}`, `restarts: ${c.restarts}`]
    if (c.last) det.push(`last termination: ${c.last}`)
    return mk('cluster', id, 'c:' + c.name, { label: `${c.init ? 'init:' : ''}${c.name}  ${c.state}  r:${c.restarts}`, status: c.status, kind: 'Container', ns, name: c.name, pod: name, detail: det })
  })
  let label = `pod/${name}  ${hl.phase}`
  if (hl.reason) label += ' ' + hl.reason
  if (hl.restarts > 0) label += ` r:${hl.restarts}` + (hl.lastRestart ? ` (last ${ago(hl.lastRestart, now)} ago)` : '')
  if (hl.started) label += `  age ${ago(hl.started, now)}`
  const containers = list(dig(p, 'spec', 'containers')).map(c => str(c, 'name'))
  const detail = [`Pod ${ns}/${name}`, `phase: ${hl.phase}`, `node: ${str(p, 'spec', 'nodeName')}`, `restarts: ${hl.restarts}`]
  if (hl.lastRestart) detail.push(`last restart: ${ago(hl.lastRestart, now)} ago`)
  if (hl.started) detail.push(`started: ${ago(hl.started, now)} ago`)
  const owner = ownerOf(p)
  if (owner) detail.push(`owner: ${owner.kind}/${owner.name}`)
  const pod = mk('cluster', parent, 'pod:' + name, { label, status: hl.st, kind: 'Pod', ns, name, containers, detail: [...detail, ...conditions(p)] })
  return [pod, ...kids]
}

/**
 * The workload a pod belongs to, from its controller ownerReference: a
 * ReplicaSet named <deployment>-<pod-template-hash> stands for its Deployment.
 * @param {unknown} p @returns {{ kind: string, name: string } | null}
 */
function ownerOf(p) {
  const refs = list(dig(p, 'metadata', 'ownerReferences'))
  const ref = refs.find(r => dig(r, 'controller') === true) ?? refs[0]
  if (!ref) return null
  const kind = str(ref, 'kind')
  const name = str(ref, 'name')
  if (kind === 'ReplicaSet') {
    const hash = str(p, 'metadata', 'labels', 'pod-template-hash')
    if (hash && name.endsWith('-' + hash)) return { kind: 'Deployment', name: name.slice(0, -hash.length - 1) }
  }
  return { kind, name }
}

/** @param {Engine} $ @param {string} ctx @param {K8sNode} nsNode @returns {Promise<K8sNode[]>} */
async function loadWorkloads($, ctx, nsNode) {
  const ns = nsNode.name
  const [w, p] = await Promise.all([
    callJSON($, 'k8s_get', { kind: 'deployments,statefulsets,daemonsets', namespace: ns, context: ctx }),
    callJSON($, 'k8s_get', { kind: 'pods', namespace: ns, context: ctx }),
  ])
  const now = Date.now()
  const pods = list(dig(p, 'items')).map(raw => ({ raw, labels: strMap(dig(raw, 'metadata', 'labels')), owner: ownerOf(raw), used: false }))
  /** @type {K8sNode[]} */
  const out = []
  const workloads = list(dig(w, 'items'))
  for (const it of workloads) {
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
    // exact: pods whose controller is this workload
    for (const pi of pods) {
      if (!pi.used && pi.owner && pi.owner.kind === kind && pi.owner.name === name) {
        pi.used = true
        out.push(...podNodes(pi.raw, ns, wn.id, now))
      }
    }
  }
  // fallback, for pods with no ownerReferences: the workload's matchLabels
  for (const it of workloads) {
    const sel = strMap(dig(it, 'spec', 'selector', 'matchLabels'))
    const keys = Object.keys(sel)
    if (keys.length === 0) continue
    const wid = `${nsNode.id}/${str(it, 'kind')}:${str(it, 'metadata', 'name')}`
    for (const pi of pods) {
      if (!pi.used && !pi.owner && keys.every(k => pi.labels[k] === sel[k])) {
        pi.used = true
        out.push(...podNodes(pi.raw, ns, wid, now))
      }
    }
  }
  // pods of Jobs (and so of CronJobs), grouped under their Job
  /** @type {Map<string, typeof pods>} */
  const jobs = new Map()
  for (const pi of pods) {
    if (pi.used || pi.owner?.kind !== 'Job') continue
    pi.used = true
    jobs.set(pi.owner.name, [...(jobs.get(pi.owner.name) ?? []), pi])
  }
  for (const [name, members] of [...jobs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const states = members.map(pi => podHealth(pi.raw, now))
    const done = states.filter(s => s.phase === 'Succeeded').length
    /** @type {K8sStatus} */
    const st = states.some(s => s.st === 'err') ? 'err' : states.some(s => s.st === 'warn') ? 'warn' : done === members.length ? '' : 'ok'
    const jn = mk('cluster', nsNode.id, 'Job:' + name, {
      label: `job/${name}  ${done}/${members.length} succeeded`,
      status: st,
      kind: 'Job',
      ns,
      name,
      detail: [`Job ${ns}/${name}`, `pods: ${members.length}, succeeded: ${done}`],
    })
    out.push(jn, ...members.flatMap(pi => podNodes(pi.raw, ns, jn.id, now)))
  }
  for (const pi of pods) if (!pi.used) out.push(...podNodes(pi.raw, ns, nsNode.id, now))
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
    const ns = str(f, 'namespace')
    return mk('rca', 'rca', 'f:' + i, {
      label: `[${sev}] ${signal}  ${ns ? ns + '/' : ''}${object}`,
      status: sev >= 8 ? 'err' : 'warn',
      kind: 'Finding',
      ns,
      name: object,
      detail: [`Finding: ${signal}`, `object: ${ns ? ns + '/' : ''}${object}`, `severity: ${sev}`, '', str(f, 'detail')],
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
  out.push(...(await loadHistory($, ctx)))
  return out
}

/**
 * RCA history (k8sh's rca-history): every problem of the last 7 days, when
 * it started, whether it came back, when it went away.
 * @param {Engine} $ @param {string} ctx @returns {Promise<K8sNode[]>}
 */
async function loadHistory($, ctx) {
  /** @type {unknown[]} */
  let recs
  try {
    recs = list(await callJSON($, 'rca_history', { context: ctx, days: 7 }))
  } catch (err) {
    return [mk('rca', 'rca', 'history', { label: 'history: ' + cut(msg(err), 80), status: 'warn', kind: 'Info' })]
  }
  const now = Date.now()
  const open = recs.filter(x => !str(x, 'resolvedAt'))
  const h = mk('rca', 'rca', 'history', {
    label: `history, 7 days: ${open.length} open · ${recs.length - open.length} resolved`,
    kind: 'History',
    detail: ['Every RCA collection is recorded on this machine (k8sh, ~/.k8sh/rca-history.json, redacted):', 'when each problem was first and last seen, how often it came back, and when it went away.'],
  })
  const kids = recs.slice(0, 200).map((x, i) => {
    const ns = str(x, 'namespace')
    const what = `${str(x, 'signal')}  ${ns ? ns + '/' : ''}${str(x, 'object')}`
    const first = Date.parse(str(x, 'firstSeen'))
    const resolved = Date.parse(str(x, 'resolvedAt'))
    const times = num(x, 'times')
    const since = Number.isNaN(first) ? '' : `since ${ago(first, now)} ago`
    const back = times > 1 ? ` · ${times}× so far` : ''
    const label = Number.isNaN(resolved) ? `open  ${what}  ${since}${back}` : `resolved ${ago(resolved, now)} ago  ${what}${back}`
    /** @type {K8sStatus} */
    const status = Number.isNaN(resolved) ? (num(x, 'severity') >= 8 ? 'err' : 'warn') : ''
    return mk('rca', h.id, 'r:' + i, {
      label,
      status,
      kind: 'Finding',
      ns,
      name: str(x, 'object'),
      detail: [
        `${str(x, 'signal')} on ${ns ? ns + '/' : ''}${str(x, 'object')}`,
        `first seen: ${str(x, 'firstSeen')}`,
        `last seen: ${str(x, 'lastSeen')}`,
        `occurrences: ${times}, seen in ${num(x, 'seen')} collections`,
        Number.isNaN(resolved) ? 'still open' : `resolved: ${str(x, 'resolvedAt')}`,
        '',
        str(x, 'detail'),
      ],
    })
  })
  if (kids.length === 0) kids.push(mk('rca', h.id, 'none', { label: '(nothing recorded in 7 days)' }))
  return [h, ...kids]
}

/**
 * Fleet: every context at a glance (k8sh fleet_status), the troubled ones first.
 * @param {Engine} $ @returns {Promise<K8sNode[]>}
 */
async function loadFleet($) {
  const rows = list(await callJSON($, 'fleet_status', {}))
  const nodes = rows.map(r => {
    const ctx = str(r, 'context')
    const reach = dig(r, 'reachable') === true
    const failing = num(r, 'podsFailing')
    const notReady = num(r, 'podsNotReady')
    const nodesAll = num(r, 'nodes')
    const nodesReady = num(r, 'nodesReady')
    const degraded = num(r, 'argoDegraded')
    const outOfSync = num(r, 'argoOutOfSync')
    const warnings = num(r, 'warnings15m')
    /** @type {K8sStatus} */
    const status = !reach || failing > 0 || nodesReady < nodesAll || degraded > 0 ? 'err' : notReady > 0 || outOfSync > 0 || warnings > 0 ? 'warn' : 'ok'
    let label = `${ctx} [${str(r, 'tier')}]  `
    if (!reach) label += 'unreachable'
    else {
      label += failing || notReady ? `pods ✖${failing} ⚠${notReady}` : `pods ✔${num(r, 'pods')}`
      label += `  nodes ${nodesReady}/${nodesAll}`
      if (dig(r, 'argoInstalled') === true) label += degraded || outOfSync ? `  argo ✖${degraded} ⚠${outOfSync}` : '  argo ✔'
      if (warnings) label += `  ${warnings} warn/15m`
    }
    const detail = reach
      ? [
          `Context ${ctx} [${str(r, 'tier')}]`,
          `nodes ready: ${nodesReady}/${nodesAll}`,
          `pods: ${num(r, 'pods')} (${failing} failing, ${notReady} not ready)`,
          `warning events, last 15 min: ${warnings}`,
          dig(r, 'argoInstalled') === true ? `Argo CD apps: ${num(r, 'argoApps')} (${degraded} degraded, ${outOfSync} out of sync)` : 'Argo CD: not installed',
          '',
          'Switch to shows it in the other tabs.',
        ]
      : [`Context ${ctx}`, 'unreachable:', str(r, 'error')]
    const n = mk('fleet', 'fleet', 'ctx:' + ctx, { label, status, kind: 'Context', name: ctx, context: ctx, detail })
    const kids = list(dig(r, 'topProblems')).map((p, i) => mk('fleet', n.id, 'p:' + i, { label: String(p), status: 'err', kind: 'Info', detail: [String(p)] }))
    return { n, kids }
  })
  nodes.sort((a, b) => rank(b.n.status) - rank(a.n.status) || a.n.name.localeCompare(b.n.name))
  const out = nodes.flatMap(x => [x.n, ...x.kids])
  if (out.length === 0) out.push(mk('fleet', 'fleet', 'none', { label: '(no contexts)' }))
  return out
}

const KINDS = /** @type {Record<string, string>} */ ({ deployment: 'Deployment', statefulset: 'StatefulSet', daemonset: 'DaemonSet', job: 'Job', cronjob: 'CronJob', pod: 'Pod', replicaset: 'ReplicaSet', namespace: 'Namespace' })

/**
 * Security: read-only posture checks (k8sh security_overview), worst first;
 * each check lists the workloads that break it, ready for Events/Describe.
 * @param {Engine} $ @param {string} ctx @returns {Promise<K8sNode[]>}
 */
async function loadSecurity($, ctx) {
  const r = await callJSON($, 'security_overview', { context: ctx })
  const sum = /** @type {Record<string, number>} */ (dig(r, 'summary') ?? {})
  /** @type {K8sNode[]} */
  const out = [
    mk('security', 'security', 'summary', {
      label: `checks failing: ${sum.high ?? 0} high · ${sum.medium ?? 0} medium · ${sum.low ?? 0} low`,
      status: (sum.high ?? 0) > 0 ? 'err' : (sum.medium ?? 0) > 0 ? 'warn' : 'ok',
      kind: 'Info',
      detail: [str(r, 'note'), ...list(dig(r, 'skipped')).map(s => 'skipped: ' + String(s))],
    }),
  ]
  for (const c of list(dig(r, 'checks'))) {
    const sev = str(c, 'severity')
    const id = str(c, 'id')
    const n = mk('security', 'security', 'check:' + id, {
      label: `${sev.toUpperCase()}  ${str(c, 'title')} (${num(c, 'count')})`,
      status: sev === 'high' ? 'err' : sev === 'medium' ? 'warn' : '',
      kind: 'Check',
      name: id,
      detail: [`${str(c, 'title')}: ${num(c, 'count')}`, `severity: ${sev}`, '', 'fix: ' + str(c, 'advice'), '', 'Change the manifests and open a PR; Ask Claude can draft it.'],
    })
    out.push(n)
    for (const o of list(dig(c, 'objects'))) {
      const s = String(o)
      // namespace/kind/name, or a clusterrolebinding line
      const m = /^([^/]+)\/([a-z]+)\/(.+)$/.exec(s)
      const kind = m ? KINDS[m[2]] ?? 'Info' : 'Info'
      out.push(
        mk('security', n.id, 'o:' + s, {
          label: s,
          status: n.status,
          kind,
          ns: m && kind !== 'Namespace' ? m[1] : '',
          name: m ? m[3] : '',
          detail: [s, `fails: ${str(c, 'title')}`, 'fix: ' + str(c, 'advice')],
        }),
      )
    }
  }
  if (out.length === 1) out.push(mk('security', 'security', 'clean', { label: 'no check failing ✔', status: 'ok' }))
  return out
}

/** @param {string} status */
const incidentStatus = status => /** @type {K8sStatus} */ (status === 'open' ? 'err' : status === 'mitigated' ? 'warn' : '')

/**
 * Incidents: the monitor's alerts of this session, then the incidents k8sh
 * keeps (active first, the last 10 resolved), each with its timeline.
 * @param {Engine} $ @returns {Promise<K8sNode[]>}
 */
async function loadIncidents($) {
  const now = Date.now()
  /** @type {K8sNode[]} */
  const out = []
  const al = mk('incidents', 'incidents', 'alerts', {
    label: `alerts, this session (${alerts.length})${monitor.timer ? '' : ' — monitoring is off'}`,
    status: alerts.some(a => a.open) ? 'err' : '',
    kind: 'Info',
    detail: ['What the monitor saw open or resolve while it ran (every ' + Math.round(monitorMs / 1000) + ' s, ' + monitorScope() + ').', 'Open incident on an alert to track it.'],
  })
  out.push(al)
  alerts.slice(0, 50).forEach((a, i) =>
    out.push(
      mk('incidents', al.id, 'a:' + i, {
        label: `${a.open ? '✖' : '✔ resolved'}  ${a.context}  ${a.ns ? a.ns + '/' : ''}${a.object}  ${a.signal}  ${ago(a.at, now)} ago`,
        status: a.open ? (a.severity >= 8 ? 'err' : 'warn') : '',
        kind: 'Alert',
        ns: a.ns,
        name: a.object,
        context: a.context,
        detail: [`${a.open ? 'Opened' : 'Resolved'}: ${a.signal} on ${a.ns ? a.ns + '/' : ''}${a.object}`, `context: ${a.context}`, `severity: ${a.severity}`, `at: ${new Date(a.at).toISOString()}`, '', a.detail],
      }),
    ),
  )
  const list_ = list(await callJSON($, 'incident_list', {}))
  const active = list_.filter(x => str(x, 'status') !== 'resolved')
  const resolved = list_.filter(x => str(x, 'status') === 'resolved').slice(0, 10)
  const ac = mk('incidents', 'incidents', 'active', { label: `active incidents (${active.length})`, status: active.length ? 'err' : 'ok', kind: 'Info' })
  const rs = mk('incidents', 'incidents', 'resolved', { label: `resolved, latest ${resolved.length}`, kind: 'Info' })
  for (const [group, items] of /** @type {const} */ ([
    [ac, active],
    [rs, resolved],
  ])) {
    out.push(group)
    for (const x of items) {
      const id = str(x, 'id')
      const opened = Date.parse(str(x, 'openedAt'))
      const n = mk('incidents', group.id, 'inc:' + id, {
        label: `${id} ${str(x, 'severity')} ${str(x, 'status')}  ${str(x, 'title')}  ${Number.isNaN(opened) ? '' : ago(opened, now) + ' ago'}`,
        status: incidentStatus(str(x, 'status')),
        kind: 'Incident',
        ns: str(x, 'namespace'),
        name: id,
        detail: [
          `${id}: ${str(x, 'title')}`,
          `severity ${str(x, 'severity')}, ${str(x, 'status')}`,
          `context: ${str(x, 'context') || '—'}${str(x, 'namespace') ? ', namespace ' + str(x, 'namespace') : ''}`,
          `objects: ${list(dig(x, 'objects')).join(', ') || '—'}`,
          `opened: ${str(x, 'openedAt')}${str(x, 'resolvedAt') ? ', resolved: ' + str(x, 'resolvedAt') : ''}`,
        ],
      })
      out.push(n)
      list(dig(x, 'timeline')).forEach((t, i) => {
        const at = Date.parse(str(t, 'at'))
        out.push(
          mk('incidents', n.id, 't:' + i, {
            label: `${Number.isNaN(at) ? '' : clock(str(t, 'at'))}  ${str(t, 'by')}: ${str(t, 'text')}`,
            status: str(t, 'kind') === 'alert' ? 'warn' : '',
            kind: 'Info',
            detail: [`${str(t, 'at')} ${str(t, 'by')} (${str(t, 'kind')})`, '', str(t, 'text')],
          }),
        )
      })
    }
    if (items.length === 0) out.push(mk('incidents', group.id, 'none', { label: group === ac ? '(none — good)' : '(none)' }))
  }
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

/** @param {Engine} $ @param {K8sTab} tab @param {string} ctx @param {boolean} [quiet] @returns {Promise<K8sNode[]>} */
function loadRoots($, tab, ctx, quiet = false) {
  switch (tab) {
    case 'argo':
      return loadApps($, ctx)
    case 'rca':
      return loadRCA($, ctx)
    case 'lock':
      return loadLock($, ctx)
    case 'fleet':
      return loadFleet($)
    case 'security':
      return loadSecurity($, ctx)
    case 'incidents':
      return loadIncidents($)
    default:
      return loadNamespaces($, ctx, quiet)
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
  if (v.context) $.ui.status(`k8s ${v.context} [${tierOf(d, v.context)}] ${lockText(d, v.context)}${monitor.timer ? ' · ◉ monitoring' : ''}`)
}

/**
 * After a refresh: a selected row that is gone (a pod replaced in a rollout)
 * gives way to its nearest ancestor still there, its workload say, and the
 * pane says so.
 * @param {Engine} $
 */
async function keepSelection($) {
  const d = await read($, data)
  const v = await read($, view)
  const sel = v.selected
  if (!sel || d.nodes[sel]) return
  let up = sel
  while (up.includes('/') && !d.nodes[up]) up = up.slice(0, up.lastIndexOf('/'))
  const next = d.nodes[up] ? up : null
  // gone for real only where its parent's rows were reloaded without it;
  // else its parent was just not reloaded (collapsed), and that says nothing
  const parent = sel.slice(0, sel.lastIndexOf('/'))
  const vanished = d.children[parent] !== undefined
  const gone = sel.slice(sel.lastIndexOf('/') + 1).replace(':', '/')
  const where = next ? crumb(d.nodes[next]) : 'the top level'
  await update($, view, w =>
    w.selected !== sel ? w : { ...w, selected: next, unlock: null, ...(vanished ? { notice: { text: `${gone} is gone (replaced or deleted); showing ${where}.`, isError: false } } : {}) },
  )
}

/**
 * Loads the visible tab's top level, then every expanded lazy node under it.
 * @param {Engine} $ @param {boolean} quiet no busy indicator
 * @param {boolean} [force] reload a cluster-wide tab even if it is fresh (⟳, opening)
 */
async function refreshTab($, quiet, force = !quiet) {
  const { tab, context: ctx } = await read($, view)
  if (!ctx) return
  // cluster-wide tabs: the background refresh reloads them at most every 2 minutes
  const key = tab + '|' + ctx
  if (!force && SLOW_TABS.has(tab) && Date.now() - (loadedAt.get(key) ?? 0) < SLOW_MS) return
  await busy($, quiet, async () => {
    try {
      const roots = await loadRoots($, tab, ctx, quiet)
      loadedAt.set(key, Date.now())
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
    await keepSelection($)
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
    await refreshTab($, true, !quiet)
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
  await findTools($)
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

// His better voice and his ears (/config): Piper, a local neural voice, and
// whisper.cpp for speech to text, both on this machine, nothing sent out.
let engineSetting = 'auto'
let piperVoiceSetting = 'en_US-ryan-medium'
let micSetting = 'default'
let whisperSetting = '~/.local/share/whisper-models/ggml-base.en.bin'
let hearingSends = false
// Off by default: an answer goes to a second model only when the person
// turned this on in /config, and the pane says so while it is on.
let readsAnswers = false
/** what was found at session start (empty: not there) */
const tools = { home: '', tmp: '/tmp', piper: '', piperModel: '', ffmpeg: '', whisper: '', whisperModel: '' }
/** afplay playing Piper's line: ending its stream stops it @type {ReturnType<Engine['process']['spawn']> | null} */
let playback = null
/** push to talk: recording now, and a press asking it to stop */
const ear = { active: false, stop: false }

/** @param {string} p */
const expand = p => (p.startsWith('~/') ? tools.home + p.slice(1) : p)

/** A program by name: the usual places, then PATH. @param {Engine} $ @param {string} name @param {string[]} places */
async function findBin($, name, places) {
  for (const p of places) if (await $.fs.exists(p).catch(() => false)) return p
  try {
    const r = await $.process.run(['/bin/sh', '-c', 'command -v "$0"', name], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

/** @param {Engine} $ */
async function findTools($) {
  tools.home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  tools.tmp = ((await $.env.get('TMPDIR').catch(() => undefined)) ?? '/tmp').replace(/\/$/, '')
  const brew = ['/opt/homebrew/bin', '/usr/local/bin']
  const [piper, ffmpeg, whisper] = await Promise.all([
    engineSetting === 'say' ? '' : findBin($, 'piper', [`${tools.home}/.local/bin/piper`, ...brew.map(b => b + '/piper')]),
    findBin($, 'ffmpeg', brew.map(b => b + '/ffmpeg')),
    findBin($, 'whisper-cli', brew.map(b => b + '/whisper-cli')),
  ])
  tools.piper = piper
  tools.ffmpeg = ffmpeg
  tools.whisper = whisper
  const model = /[/]|\.onnx$/.test(piperVoiceSetting) ? expand(piperVoiceSetting) : `${tools.home}/.local/share/piper-voices/${piperVoiceSetting}.onnx`
  tools.piperModel = (await $.fs.exists(model).catch(() => false)) ? model : ''
  const wm = expand(whisperSetting)
  tools.whisperModel = (await $.fs.exists(wm).catch(() => false)) ? wm : ''
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
  hush()
  const hushed = typeof AbortController === 'function' ? new AbortController() : null
  steve.hush = hushed
  steve.speaking = true
  try {
    // Piper (local, neural) when it and its voice are there, else macOS say
    if (engineSetting !== 'say' && tools.piper && tools.piperModel && (await speakPiper($, line, hushed))) return
    if (hushed?.signal.aborted) return
    try {
      await $.audio.speak(line, { voice: voiceName, ...(hushed ? { signal: hushed.signal } : {}) })
    } catch (err) {
      // the chosen voice is not installed here: the system's default voice
      if (hushed?.signal.aborted) throw err
      await $.audio.speak(line, hushed ? { signal: hushed.signal } : undefined)
    }
  } catch {
    // no synthesizer, or cut off by the next line
  } finally {
    if (steve.hush === hushed) {
      steve.speaking = false
      steve.hush = null
    }
  }
}

/**
 * Piper renders the line to a WAV, afplay plays it; true once played (or
 * cut off by the next line), false when Piper failed and say should try.
 * @param {Engine} $ @param {string} line @param {AbortController | null} hushed
 */
async function speakPiper($, line, hushed) {
  const wav = `${tools.tmp}/steve-${Math.random().toString(36).slice(2)}.wav`
  try {
    const r = await $.process.run([tools.piper, '-m', tools.piperModel, '-f', wav], { stdin: line, timeoutMs: 30000 })
    if (r.exitCode !== 0) return false
    if (hushed?.signal.aborted) return true
    const play = $.process.spawn({ argv: ['/usr/bin/afplay', wav] })
    playback = play
    for await (const _ of play) if (hushed?.signal.aborted) break
    return true
  } catch {
    return false
  } finally {
    playback = null
    void $.process.run(['/bin/rm', '-f', wav]).catch(() => undefined)
  }
}

function hush() {
  steve.hush?.abort()
  steve.hush = null
  steve.speaking = false
  // cuts afplay off mid-line: ending its stream kills it
  void playback?.return({ code: null, signal: 'SIGTERM' })
  playback = null
}

/**
 * Steve's ears: push to talk. The first press records the microphone
 * (ffmpeg, avfoundation) until you stop talking (its silence detector), a
 * second press, or 30 s; whisper.cpp turns it into text on this machine; the
 * text goes into the prompt box (or is sent, with steveHearingSends on).
 * Nothing records unless the person pressed the button.
 * @param {Engine} $
 */
async function hear($) {
  if (ear.active) {
    ear.stop = true
    return
  }
  if (!tools.ffmpeg || !tools.whisper || !tools.whisperModel) {
    await notify($, `Steve can't hear yet: he needs ${[!tools.ffmpeg && 'ffmpeg', !tools.whisper && 'whisper-cli', !tools.whisperModel && `a Whisper model at ${whisperSetting}`].filter(Boolean).join(', ')}. See the README.`, true)
    return
  }
  hush()
  ear.active = true
  ear.stop = false
  const id = Math.random().toString(36).slice(2)
  const raw = `${tools.tmp}/steve-ear-${id}.raw`
  const wav = `${tools.tmp}/steve-ear-${id}.wav`
  try {
    await update($, view, w => ({ ...w, ear: /** @type {const} */ ('rec') }))
    steve.thinking = false
    steve.listenUntil = fxFrame + F(31000)
    steve.bubble = steveLine('hearing', salty)
    steve.bubbleUntil = fxFrame + F(31000)
    let log = ''
    let spoke = false
    try {
      // raw PCM, so a recording cut off by a press still decodes
      const rec = $.process.spawn({
        argv: [tools.ffmpeg, '-hide_banner', '-nostdin', '-stats', '-f', 'avfoundation', '-i', ':' + micSetting, '-t', '30', '-ac', '1', '-ar', '16000', '-af', 'silencedetect=noise=-35dB:d=1.2', '-f', 's16le', '-y', raw],
      })
      for await (const { text } of rec) {
        log = (log + text).slice(-4000)
        if (ear.stop) break
        if (/silence_end:/.test(text)) spoke = true
        // a pause after speech: done (the leading silence starts at 0)
        if ([...text.matchAll(/silence_start: (-?[\d.]+)/g)].some(m => Number(m[1]) > 0.6)) break
        // nothing said for 8 s: give up
        const t = /time=(\d+):(\d+):([\d.]+)/.exec(text)
        if (!spoke && t && Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) > 8 && /silence_start: 0\b|silence_start: -?0\.\d/.test(log)) break
      }
    } catch (err) {
      log += msg(err)
    }
    steve.listenUntil = 0
    steve.bubbleUntil = 0
    const size = (await $.fs.exists(raw)) ? (await $.fs.stat(raw)).size : 0
    if (size < 16000 * 2 * 0.4) {
      const deaf = /not authori[sz]ed|permission|Input\/output error|Error opening input|Could not|No such device/i.test(log)
      await say($, steveLine(deaf ? 'deaf' : 'heardNothing', salty), { mood: 'oops', moodMs: 1200, aloud: !deaf })
      return
    }
    await update($, view, w => ({ ...w, ear: /** @type {const} */ ('stt') }))
    steve.thinking = true
    const conv = await $.process.run([tools.ffmpeg, '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', raw, wav], { timeoutMs: 30000 })
    if (conv.exitCode !== 0) throw new Error(conv.stderr.trim() || 'ffmpeg could not convert the recording')
    const r = await $.process.run([tools.whisper, '-m', tools.whisperModel, '-f', wav, '-nt', '-np', '-l', 'en'], { timeoutMs: 120000 })
    steve.thinking = false
    const heard = r.stdout
      .replace(/\[[A-Z_ ]+\]|\([a-z ]+\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (r.exitCode !== 0 || !heard) {
      await say($, steveLine('heardNothing', salty), { mood: 'oops', moodMs: 1200 })
      return
    }
    if (hearingSends) await $.prompt.submit({ text: heard, asUser: true })
    else await $.prompt.fill({ text: heard, mode: 'append' })
    await say($, `“${cut(heard, 90)}”`, { aloud: false })
  } catch (err) {
    steve.thinking = false
    await notify($, `Steve couldn't hear: ${cut(msg(err), 200)}`, true)
  } finally {
    ear.active = false
    steve.listenUntil = 0
    await update($, view, w => ({ ...w, ear: undefined }))
    void $.process.run(['/bin/rm', '-f', raw, wav]).catch(() => undefined)
  }
}

/** What Claude is doing, from the tool it calls; names a kind, never arguments' values. @param {Record<string, unknown>} e */
function toolLine(e) {
  return steveTool(String(e.tool), typeof e.kind === 'string' ? e.kind.split(',')[0] : '', TOOL_PREFIX)
}

/** After a refresh: a facepalm and a line for a problem the pane had not shown before. @param {Engine} $ @param {string} ctx */
async function noticeProblems($, ctx) {
  const d = await read($, data)
  // things that break: workloads and apps (not posture checks or incidents)
  const errs = Object.values(d.nodes).filter(n => n.status === 'err' && (n.tab === 'cluster' || n.tab === 'argo'))
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

// ---------- monitoring ----------
//
// While on, every monitorEverySeconds it runs rca_collect on the watched
// contexts. k8sh records each run in its RCA history and says what opened
// and what resolved since the last one: those become alerts (a toast, Steve,
// the Incidents tab) and notes on the active incidents that name the object.
// Off by default; the Incidents tab switches it. Read-only, like the rest.

/** @typedef {{ context: string, ns: string, object: string, signal: string, severity: number, detail: string, at: number, open: boolean }} Alert */
/** newest first, this session only @type {Alert[]} */
const alerts = []
const monitor = {
  /** @type {{ cancel: () => void } | null} */
  timer: null,
  running: false,
  /** contexts the last run could not reach */
  unreachable: /** @type {Set<string>} */ (new Set()),
  /** contexts whose first run this session is done: that run is the baseline */
  baselined: /** @type {Set<string>} */ (new Set()),
}
let monitorMs = 60000
let monitorContexts = 'current'

const monitorScope = () => (monitorContexts === 'current' ? 'the current context' : monitorContexts === 'all' ? 'every context' : monitorContexts)

/** @param {Engine} $ @returns {Promise<string[]>} */
async function watched($) {
  if (monitorContexts === 'all') return (await loadContexts($)).map(c => c.name).slice(0, 10)
  if (monitorContexts !== 'current')
    return monitorContexts
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
      .slice(0, 10)
  const ctx = (await read($, view)).context ?? (await loadContexts($)).find(c => c.current)?.name
  return ctx ? [ctx] : []
}

/** @param {Engine} $ */
function startMonitor($) {
  if (monitor.timer) return
  monitor.timer = $.clock.every(monitorMs, () => {
    void monitorTick($)
  })
  $.clock.after(1, () => {
    void monitorTick($)
  })
}

function stopMonitor() {
  monitor.timer?.cancel()
  monitor.timer = null
}

/** @param {string} context @param {unknown} x @param {boolean} open @returns {Alert} */
const toAlert = (context, x, open) => ({ context, ns: str(x, 'namespace'), object: str(x, 'object'), signal: str(x, 'signal'), severity: num(x, 'severity'), detail: str(x, 'detail'), at: Date.now(), open })

/**
 * Whether an incident's object names what an alert is about: the object
 * itself or its pod (pod/api-2 for pod/api-2/app), or the workload whose
 * pods it names (deployment/api for pod/api-7d9-x).
 * @param {string} o @param {Alert} a
 */
function names(o, a) {
  const bare = o.replace(/^[^/]+\/(?=(pod|deployment|statefulset|daemonset|job|namespace)\/)/, '')
  const full = `${a.ns}/${a.object}`
  if (a.object === bare || a.object.startsWith(bare + '/') || full === o || full.startsWith(o + '/')) return true
  const w = /^(deployment|statefulset|daemonset|job)\/(.+)$/.exec(bare)
  return Boolean(w && a.object.startsWith(`pod/${w[2]}-`))
}

/** One monitoring run. @param {Engine} $ */
async function monitorTick($) {
  if (monitor.running) return
  monitor.running = true
  try {
    /** @type {Alert[]} */
    const fresh = []
    /** @type {Alert[]} */
    const gone = []
    for (const ctx of await watched($)) {
      let r
      try {
        r = await callJSON($, 'rca_collect', { context: ctx })
      } catch (err) {
        if (!monitor.unreachable.has(ctx)) {
          monitor.unreachable.add(ctx)
          fresh.push({ context: ctx, ns: '', object: 'cluster', signal: 'Unreachable', severity: 9, detail: msg(err), at: Date.now(), open: true })
        }
        continue
      }
      if (monitor.unreachable.delete(ctx)) gone.push({ context: ctx, ns: '', object: 'cluster', signal: 'Unreachable', severity: 9, detail: 'reachable again', at: Date.now(), open: false })
      // the first run of a session is the baseline: what is broken already is
      // said once, in one line; alerts are for what changes from here
      if (!monitor.baselined.has(ctx)) {
        monitor.baselined.add(ctx)
        const now = list(dig(r, 'findings')).filter(x => num(x, 'severity') >= 7).length + num(r, 'truncated')
        $.ui.toast(`◉ monitoring ${ctx}: ${now} problem${now === 1 ? '' : 's'} open now (RCA tab). You'll hear about changes from here.`)
        continue
      }
      for (const x of list(dig(r, 'opened'))) if (num(x, 'severity') >= 7) fresh.push(toAlert(ctx, x, true))
      for (const x of list(dig(r, 'resolved'))) if (num(x, 'severity') >= 7) gone.push(toAlert(ctx, x, false))
    }
    if (fresh.length === 0 && gone.length === 0) return
    alerts.unshift(...fresh, ...gone)
    if (alerts.length > 200) alerts.length = 200

    const where = (/** @type {Alert} */ a) => `${a.context}: ${a.signal} ${a.ns ? a.ns + '/' : ''}${a.object}`
    if (fresh.length > 0) {
      $.ui.toast(fresh.length === 1 ? `✖ ${where(fresh[0])}` : `✖ ${fresh.length} new problems — ${where(fresh[0])}, …`, { timeoutMs: 8000 })
      if (fxTimer && fxLook === 'steve') await say($, steveLine('broke', salty, { x: `${fresh[0].ns ? fresh[0].ns + '/' : ''}${fresh[0].object}` }), { mood: 'oops', moodMs: 2000 })
    } else {
      $.ui.toast(gone.length === 1 ? `✔ resolved — ${where(gone[0])}` : `✔ ${gone.length} problems resolved — ${where(gone[0])}, …`)
    }

    // on the timeline of every active incident that names the object
    const active = list(await callJSON($, 'incident_list', { status: 'active' }).catch(() => []))
    for (const a of [...fresh, ...gone]) {
      for (const inc of active) {
        if (str(inc, 'context') && str(inc, 'context') !== a.context) continue
        if (!list(dig(inc, 'objects')).some(o => names(String(o), a))) continue
        await callJSON($, 'incident_note', { id: str(inc, 'id'), text: `${a.open ? 'alert' : 'resolved'}: ${a.signal} on ${a.ns ? a.ns + '/' : ''}${a.object}`, kind: 'alert', by: 'monitor' }).catch(() => null)
      }
    }
    if (timer && (await read($, view)).tab === 'incidents') await refreshTab($, true, true)
  } finally {
    monitor.running = false
  }
}

/** @param {Engine} $ */
async function toggleMonitor($) {
  const on = !(await read($, view)).monitor
  await update($, view, w => ({ ...w, monitor: on }))
  if (on) startMonitor($)
  else stopMonitor()
  await notify($, on ? `Monitoring ${monitorScope()} every ${Math.round(monitorMs / 1000)} s: new and resolved problems show here, as a toast, and on matching incidents.` : 'Monitoring off.')
  await syncStatus($)
  if ((await read($, view)).tab === 'incidents') await refreshTab($, true, true)
}

// ---------- incidents ----------

/** What an incident about a row names. @param {K8sNode} n */
function incidentObjects(n) {
  if (n.kind === 'Context') return ['context/' + n.name]
  if (n.kind === 'Finding' || n.kind === 'Alert') return [n.ns ? `${n.ns}/${n.name}` : n.name]
  if (n.kind === 'Namespace') return ['namespace/' + n.name]
  if (n.kind === 'Container') return [`${n.ns}/pod/${n.pod}`]
  if (isObject(n)) return [`${n.ns ? n.ns + '/' : ''}${targetOf(n)}`]
  return []
}

/** A title from the row. @param {K8sNode} n */
const incidentTitle = n => cut(n.label.replace(/\s+/g, ' ').trim(), 120)

/** @param {Engine} $ @param {K8sNode} n */
async function openIncidentForm($, n) {
  /** @type {import('../types').K8sForm} */
  const form = { kind: 'open', nodeId: n.id, severity: n.status === 'err' ? 'sev2' : 'sev3' }
  await update($, view, w => ({ ...w, unlock: null, detail: null, form }))
}

/** @param {Engine} $ @param {K8sNode} n */
async function openNoteForm($, n) {
  /** @type {import('../types').K8sForm} */
  const form = { kind: 'note', nodeId: n.id }
  await update($, view, w => ({ ...w, unlock: null, detail: null, form }))
}

/** @param {Engine} $ @param {string} typed */
async function submitIncident($, typed) {
  const v = await read($, view)
  const d = await read($, data)
  const f = v.form
  const n = f ? d.nodes[f.nodeId] : undefined
  if (!f || !n) return
  const setF = /** @param {Partial<import('../types').K8sForm>} patch */ patch => update($, view, w => (w.form && w.form.nodeId === f.nodeId ? { ...w, form: { ...w.form, ...patch } } : w))
  await setF({ isBusy: true, error: undefined })
  try {
    if (f.kind === 'open') {
      const inc = await callJSON($, 'incident_open', {
        title: typed.trim() || incidentTitle(n),
        severity: f.severity ?? 'sev3',
        context: n.context ?? v.context ?? '',
        namespace: n.ns,
        objects: incidentObjects(n).join(','),
        note: n.detail.filter(Boolean).slice(0, 4).join(' · '),
        by: 'pane',
      })
      await update($, view, w => ({ ...w, form: null, notice: { text: `${str(inc, 'id')} opened (${str(inc, 'severity')}): ${str(inc, 'title')}. It is on the Incidents tab (7).`, isError: false } }))
    } else {
      if (!typed.trim()) return void (await setF({ isBusy: false, error: 'Write a note first.' }))
      await callJSON($, 'incident_note', { id: n.name, text: typed, by: 'pane' })
      await update($, view, w => ({ ...w, form: null, notice: { text: `Noted on ${n.name}.`, isError: false } }))
    }
  } catch (err) {
    await setF({ isBusy: false, error: msg(err) })
    return
  }
  if (v.tab === 'incidents') await refreshTab($, true, true)
}

/** @param {Engine} $ @param {K8sNode} n @param {'open' | 'mitigated' | 'resolved'} status */
async function setIncident($, n, status) {
  try {
    await callJSON($, 'incident_status', { id: n.name, status, by: 'pane' })
    await notify($, `${n.name} is ${status}.`)
  } catch (err) {
    await notify($, msg(err), true)
  }
  await refreshTab($, true, true)
}

/** Ask Claude for a blameless postmortem of an incident. @param {Engine} $ @param {K8sNode} n */
async function postmortem($, n) {
  const text = [
    `From the k8s pane: draft a blameless postmortem for incident ${n.name} as markdown in docs/incidents/${n.name}.md.`,
    `Use incident_list for its timeline, rca_history for when the problems started, came back and resolved, and the Argo CD and Git history for what changed.`,
    'Sections: summary, impact, timeline (UTC), root cause, contributing factors, what went well, what went badly, action items (each as a PR or issue to open). Read-only: change nothing in the cluster.',
    '',
    ...n.detail,
  ].join('\n')
  const redacted = await $.session.redact(text).catch(() => text)
  await $.prompt.submit({ text: cut(redacted, 6000), asUser: true })
  await notify($, `Asked Claude for a postmortem of ${n.name}.`)
}

/** The light refresh: the visible tab and the lock, only while the pane is open. @param {Engine} $ */
async function tick($) {
  if (ticking) return
  ticking = true
  try {
    if (!(await isOpen($))) return stopTimer()
    // the Lock tab loads the grants itself
    if ((await read($, view)).tab !== 'lock') {
      const grants = await loadGrants($).catch(() => null)
      if (grants) {
        await update($, data, d => ({ ...d, grants }))
        await syncStatus($)
      }
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
  // the Incidents tab opens with its alerts and active incidents unfolded
  const unfold = tab === 'incidents' ? ['incidents/alerts', 'incidents/active'] : []
  await update($, view, v => ({ ...v, tab, selected: null, detail: null, unlock: null, form: null, notice: null, expanded: [...new Set([...v.expanded, ...unfold])] }))
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
const isObject = n => n.name !== '' && !['Info', 'Finding', 'Event', 'Grant', 'Context', 'Lock', 'Alert', 'Check', 'Incident', 'History'].includes(n.kind)

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
 *   | { type: 'loading', depth: number }
 *   | { type: 'none', depth: number, text: string }} Row
 */

/** @param {K8sData} d @param {K8sView} v @returns {Row[]} */
function rowsOf(d, v) {
  /** @type {Row[]} */
  const rows = []
  /** @param {string} parent @param {number} depth */
  const walk = (parent, depth) => {
    const err = d.errors[parent]
    if (err) rows.push({ type: 'error', parent, text: err, depth })
    let kids = d.children[parent]
    if (!kids) {
      if (!err) rows.push({ type: 'loading', depth })
      return
    }
    // the filter narrows the top level; problems only hides ✔ rows everywhere
    const needle = (v.filter ?? '').trim().toLowerCase()
    if (depth === 0 && needle) kids = kids.filter(id => d.nodes[id]?.label.toLowerCase().includes(needle))
    if (v.problemsOnly) kids = kids.filter(id => d.nodes[id] && (d.nodes[id].status === 'err' || d.nodes[id].status === 'warn'))
    if (kids.length === 0 && depth === 0 && (needle || v.problemsOnly)) {
      rows.push({ type: 'none', depth, text: v.problemsOnly && !needle ? 'no problems here ✔' : 'nothing matches' })
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
    // a namespace counts its pods; any other row counts itself
    const all = (d.children[v.tab] ?? []).map(id => d.nodes[id]).filter(Boolean)
    const errs = all.reduce((s, n) => s + (n.counts ? n.counts.err : n.status === 'err' ? 1 : 0), 0)
    const warns = all.reduce((s, n) => s + (n.counts ? n.counts.warn : n.status === 'warn' ? 1 : 0), 0)
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
      // said while it happens: every finished answer, redacted, goes to haiku
      Raster && look === 'steve' && readsAnswers ? h(Text, { color: 'warning' }, '👁 reads answers (haiku)') : null,
      e.surface === 'terminal'
        ? h(Button, {
            key: 'talk',
            label: v.ear === 'rec' ? '● listening… (press to stop)' : v.ear === 'stt' ? '… transcribing' : '🎤 talk',
            plain: true,
            color: v.ear === 'rec' ? 'error' : undefined,
            dimColor: v.ear === 'stt',
            onPress: () => hear($),
          })
        : null,
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

  // filter and problems only
  out.push(
    h(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 },
      h(Input, {
        key: 'filter',
        placeholder: 'filter…',
        value: v.filter ?? '',
        submitLabel: 'filter',
        onInput: (/** @type {string} */ text) => update($, view, w => ({ ...w, filter: text })),
        onSubmit: (/** @type {string} */ text) => update($, view, w => ({ ...w, filter: text })),
      }),
      h(Button, { key: 'problems', label: v.problemsOnly ? '⚠ problems only' : '⚠ all rows', plain: true, dimColor: !v.problemsOnly, onPress: () => update($, view, w => ({ ...w, problemsOnly: !w.problemsOnly })) }),
      v.filter ? h(Button, { key: 'filter-clear', label: '✕', plain: true, onPress: () => update($, view, w => ({ ...w, filter: '' })) }) : null,
    ),
  )

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

  // 4. actions, right under the breadcrumb: in reach however long the tree
  // or the detail below gets
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
  // fleet: show a context in the other tabs
  if (sel?.kind === 'Context' && sel.context) {
    const target = sel.context
    acts.push(
      h(Button, {
        key: 'act:switch',
        label: 'Switch to',
        onPress: async () => {
          await switchContext($, target)
          await switchTab($, 'cluster')
        },
      }),
    )
  }
  // incidents: from any problem row; on an incident, its life cycle
  if (sel && sel.kind !== 'Incident' && (sel.status === 'err' || sel.status === 'warn') && v.tab !== 'lock') acts.push(h(Button, { key: 'act:incident', label: 'Open incident…', onPress: () => openIncidentForm($, sel) }))
  if (sel?.kind === 'Incident') {
    const status = sel.status === 'err' ? 'open' : sel.status === 'warn' ? 'mitigated' : 'resolved'
    acts.push(h(Button, { key: 'act:note', label: 'Note…', onPress: () => openNoteForm($, sel) }))
    if (status === 'open') acts.push(h(Button, { key: 'act:mitigate', label: 'Mitigated', onPress: () => setIncident($, sel, 'mitigated') }))
    if (status !== 'resolved') acts.push(h(Button, { key: 'act:resolve', label: 'Resolve', onPress: () => setIncident($, sel, 'resolved') }))
    else acts.push(h(Button, { key: 'act:reopen', label: 'Reopen', onPress: () => setIncident($, sel, 'open') }))
    acts.push(h(Button, { key: 'act:postmortem', label: 'Draft postmortem', onPress: () => postmortem($, sel) }))
  }
  if (v.tab === 'incidents') acts.push(h(Button, { key: 'act:monitor', label: monitor.timer ? '◉ Monitoring on' : '○ Monitoring off', variant: monitor.timer ? 'primary' : undefined, onPress: () => toggleMonitor($) }))
  out.push(h(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 }, ...acts))

  // 5. tree; while a detail or the unlock is open, only the rows around the
  // selection, so the detail stays near the top
  let rows = rowsOf(d, v)
  const unlockOpen = Boolean(v.unlock && sel && v.unlock.nodeId === sel.id)
  /** @type {unknown[]} */
  const tree = []
  if ((v.detail || unlockOpen) && rows.length > TREE_WHILE_DETAIL) {
    const at = Math.max(0, rows.findIndex(r => r.type === 'node' && r.node.id === v.selected))
    const start = Math.max(0, Math.min(at - 3, rows.length - TREE_WHILE_DETAIL))
    const above = start
    const below = rows.length - start - TREE_WHILE_DETAIL
    rows = rows.slice(start, start + TREE_WHILE_DETAIL)
    if (above > 0) tree.push(h(Text, { dimColor: true }, `  ⋮ ${above} rows above`))
    if (below > 0) rows.push({ type: 'none', depth: 0, text: `⋮ ${below} rows below (✕ close the detail to see them all)` })
  }
  for (const r of rows) {
    const pad = '  '.repeat(r.depth)
    if (r.type === 'loading') tree.push(h(Text, { dimColor: true }, pad + '  loading…'))
    else if (r.type === 'none') tree.push(h(Text, { dimColor: true }, pad + '  ' + r.text))
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

  // 6. detail
  out.push(h(Text, { dimColor: true }, '─'.repeat(Math.min(cols, 120))))
  if (v.form && sel && v.form.nodeId === sel.id) {
    const f = v.form
    const isOpen = f.kind === 'open'
    out.push(
      h(
        Box,
        { flexDirection: 'column' },
        h(Text, { bold: true }, isOpen ? `Open an incident — ${sel.context ?? ctx ?? ''}` : `Note on ${sel.name}`),
        isOpen ? h(Text, { dimColor: true }, `about: ${incidentObjects(sel).join(', ') || sel.label.trim()}`) : null,
        isOpen
          ? h(
              Box,
              { flexDirection: 'row', columnGap: 2 },
              h(Text, null, 'severity:'),
              ...['sev1', 'sev2', 'sev3', 'sev4'].map(s =>
                h(Button, {
                  key: 'sev:' + s,
                  label: s,
                  plain: true,
                  dimColor: s !== f.severity,
                  onPress: () => update($, view, w => (w.form ? { ...w, form: { ...w.form, severity: /** @type {'sev1' | 'sev2' | 'sev3' | 'sev4'} */ (s) } } : w)),
                }),
              ),
            )
          : null,
        f.isBusy
          ? h(Text, { dimColor: true }, isOpen ? 'opening…' : 'saving…')
          : h(Input, {
              key: isOpen ? 'incident-title' : 'incident-note',
              placeholder: isOpen ? cut(incidentTitle(sel), 60) + ' (Enter keeps it)' : 'what happened, what you did',
              submitLabel: isOpen ? 'open' : 'note',
              autoFocus: true,
              onSubmit: (/** @type {string} */ typed) => submitIncident($, typed),
            }),
        f.error ? h(Text, { color: 'error' }, '✖ ' + f.error) : null,
        h(Text, { dimColor: true }, isOpen ? 'Kept on this machine by k8sh (~/.k8sh/incidents.json), redacted. Nothing changes in the cluster.' : 'Added to the timeline, redacted.'),
        h(Button, { key: 'form-cancel', label: 'Cancel', onPress: () => update($, view, w => ({ ...w, form: null })) }),
      ),
    )
  } else if (v.unlock && sel && v.unlock.nodeId === sel.id && ctx) {
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
  if (typeof options?.steveEngine === 'string' && options.steveEngine) engineSetting = options.steveEngine
  if (typeof options?.stevePiperVoice === 'string' && options.stevePiperVoice) piperVoiceSetting = options.stevePiperVoice
  if (typeof options?.steveMicrophone === 'string' && options.steveMicrophone) micSetting = options.steveMicrophone
  if (typeof options?.steveWhisperModel === 'string' && options.steveWhisperModel) whisperSetting = options.steveWhisperModel
  if (typeof options?.steveHearingSends === 'boolean') hearingSends = options.steveHearingSends
  readsAnswers = options?.steveReadsAnswers === true
  if (typeof options?.monitorContexts === 'string' && options.monitorContexts.trim()) monitorContexts = options.monitorContexts.trim()
  if (typeof options?.monitorEverySeconds === 'number') monitorMs = Math.max(30, Math.min(3600, options.monitorEverySeconds)) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'k8s',
      description: 'Open or close the k8s pane beside the chat (Cluster, Argo CD, RCA, Lock)',
      immediate: true,
    })
    await loadLabel($)
    void pickVoice($)
    await update($, view, v => ({ ...v, busy: 0, unlock: v.unlock ? { ...v.unlock, isBusy: false } : null, ear: undefined, form: v.form ? { ...v.form, isBusy: false } : null }))
    // monitoring switched on in this session carries over a reload
    if ((await read($, view)).monitor) startMonitor($)
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
          // his own take (haiku) only when the person opted in; else a canned line
          const said = readsAnswers ? await react($, e.answer) : steveLine('done', salty)
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
