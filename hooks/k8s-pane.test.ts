import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { linesFor, persona } from './steve-lines.js'
import { autoVoice } from './k8s-pane.js'

// A fixture cluster behind the k8sh MCP server, and the rest of the engine
// the pane reaches: panes, the status line, processes, files, the prompt.

const PANE = {
  plugin: 'devops-assistant',
  component: 'Pane',
  requestId: 'k8s',
  props: {
    title: 'k8s',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const CTX = 'k3d-mycluster'
const NS = 'cluster/ns:payments'
const DEPLOY = NS + '/Deployment:api'
const POD = DEPLOY + '/pod:api-2'
const CONTAINER = POD + '/c:app'

const pod = (name: string, waiting: string, restarts: number, last: string) => ({
  metadata: { name, namespace: 'payments', labels: { app: 'api' } },
  spec: { nodeName: 'k3d-agent-0', containers: [{ name: 'app' }] },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: waiting ? 'False' : 'True' }],
    containerStatuses: [
      {
        name: 'app',
        image: 'ghcr.io/acme/api:1.4.2',
        ready: !waiting,
        restartCount: restarts,
        state: waiting ? { waiting: { reason: waiting } } : { running: {} },
        lastState: last ? { terminated: { reason: last, exitCode: 137 } } : {},
      },
    ],
  },
})

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

// in deploy/api only by its ReplicaSet (no app label): restarted 5 minutes ago, 2 days old
const api3 = {
  metadata: { name: 'api-3', namespace: 'payments', labels: { 'pod-template-hash': '6b8d' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'api-6b8d', controller: true }] },
  spec: { nodeName: 'k3d-agent-1', containers: [{ name: 'app' }] },
  status: {
    phase: 'Running',
    startTime: ago(2 * 86400e3),
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'app', image: 'ghcr.io/acme/api:1.4.2', ready: true, restartCount: 3, state: { running: {} }, lastState: { terminated: { reason: 'Error', exitCode: 1, finishedAt: ago(5 * 60e3) } } }],
  },
}

// a Job's pod stuck in its init container
const migrate = {
  metadata: { name: 'migrate-x7', namespace: 'payments', labels: { 'job-name': 'migrate' }, ownerReferences: [{ kind: 'Job', name: 'migrate', controller: true }] },
  spec: { containers: [{ name: 'run' }] },
  status: {
    phase: 'Pending',
    initContainerStatuses: [{ name: 'wait-db', image: 'busybox:1.36', ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: {} }],
    containerStatuses: [{ name: 'run', image: 'ghcr.io/acme/migrate:2', ready: false, restartCount: 0, state: { waiting: { reason: 'PodInitializing' } }, lastState: {} }],
  },
}

type Call = { server: string; tool: string; args: Record<string, unknown> }
type Incident = {
  id: string
  title: string
  severity: string
  status: string
  context: string
  namespace: string
  objects: string[]
  openedAt: string
  timeline: { at: string; by: string; kind: string; text: string }[]
}
type Run = { argv: readonly string[]; init?: { stdin?: string } }

type World = {
  calls: Call[]
  runs: Run[]
  submitted: { text: string; origin?: { kind: string; asUser?: boolean } }[]
  status: { text: string | undefined }
  closed: number
  grants: unknown[]
  argoInstalled: boolean
  blits: { requestId: string; key: string; cells: string; columns?: number; rows?: number }[]
  spoken: string[]
  voices: (string | undefined)[]
  asked: { model: string; system?: unknown; prompt: unknown }[]
  quip: string
  /** what `say -v '?'` lists */
  installed: string
  /** deploy/api's labelled pods (a rollout replaces them) */
  pods: unknown[]
  /** programs `command -v` finds, by name */
  bins: Record<string, string>
  /** whether every file asked about exists (voice models, recordings) */
  exists: boolean
  /** a recording's size in bytes */
  recorded: number
  /** what ffmpeg prints while recording, piece by piece */
  mic: string[]
  /** what whisper-cli hears */
  transcript: string
  /** lines handed to piper */
  piped: (string | undefined)[]
  /** argv of every spawned process */
  spawned: (readonly string[])[]
  /** argv of the speech tools' runs */
  speechRuns: (readonly string[])[]
  /** text put in the prompt box */
  filled: string[]
  /** k8sh's incident store */
  incidents: Incident[]
  /** RCA history records */
  history: unknown[]
  /** problems the next rca_collect reports as opened / resolved */
  opened: unknown[]
  resolved: unknown[]
  toasts: string[]
}

function world(on: On): World {
  const w: World = { calls: [], runs: [], submitted: [], status: { text: undefined }, closed: 0, grants: [], argoInstalled: true, blits: [], spoken: [], voices: [], asked: [], quip: '"Of course it got OOMKilled. Who the hell set that memory limit?"', installed: 'Fred                en_US    # Hello! My name is Fred.\nRocko (English (US)) en_US    # Hello! My name is Rocko.\n', pods: [pod('api-1', '', 0, ''), pod('api-2', 'CrashLoopBackOff', 7, 'OOMKilled')], bins: {}, exists: false, recorded: 64000, mic: [], transcript: '', piped: [], spawned: [], speechRuns: [], filled: [], incidents: [], history: [], opened: [], resolved: [], toasts: [] }
  let open = false

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    open = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: open ? [{ id: 'k8s', title: 'k8s', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.close', () => {
    open = false
    w.closed += 1
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.status.text = e.text
    return { value: undefined }
  })
  on('ui.blit', (_, e) => {
    w.blits.push(e as World['blits'][number])
    return { value: {} }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  // models and recordings; programs are found through `command -v` (w.bins)
  on('fs.exists', (_, e) => ({ value: w.exists && !/\/(piper|ffmpeg|whisper-cli)$/.test(e.path) }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: w.recorded, mtimeMs: 0, isLink: false } }))
  on('process.spawn', async function* (_, e) {
    w.spawned.push(e.argv)
    // (the kit wants at least one chunk, each with some text)
    if (e.argv[0] === w.bins.ffmpeg) for (const text of w.mic) yield { stream: 'stderr' as const, text }
    else yield { stream: 'stdout' as const, text: '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.fill', (_, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.edit', (_, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer, reason: 'answered' as const }))
  on('model.complete', (_, e) => {
    w.asked.push(e as World['asked'][number])
    return { value: { isAnswered: true as const, text: w.quip, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('audio.speak', (_, e) => {
    w.spoken.push(e.text)
    w.voices.push((e as { voice?: string }).voice)
    return { value: { synthesizer: 'say' } }
  })
  on('session.redact', (_, e) => ({ value: e.text.replace(/s3cr3t/g, '[REDACTED]') }))
  on('prompt.submit', (_, e) => {
    w.submitted.push(e as World['submitted'][number])
    return { text: e.text }
  })
  on('tool.call', () => ({ result: {} }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:devops-assistant:k8sh' } }))
  on('mcp.call', (_, e) => {
    w.calls.push(e)
    const text = (v: unknown) => ({ value: { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }], isError: false } })
    const fail = (t: string) => ({ value: { content: [{ type: 'text', text: t }], isError: true } })
    const a = e.args
    switch (e.tool) {
      case 'k8s_contexts':
        return text([
          { name: CTX, tier: 'dev', current: true },
          { name: 'eks-prod', tier: 'prod', current: false },
        ])
      case 'lock_status':
        return text({ state: 'LOCKED', grants: w.grants })
      case 'k8s_get':
        if (a.kind === 'namespaces')
          return text(JSON.stringify({ items: [{ metadata: { name: 'payments', creationTimestamp: '2026-11-01T00:00:00Z' }, status: { phase: 'Active' } }, { metadata: { name: 'kube-system' }, status: { phase: 'Active' } }] }))
        if (a.kind === 'deployments,statefulsets,daemonsets')
          return text(
            JSON.stringify({
              items: [
                {
                  kind: 'Deployment',
                  metadata: { name: 'api' },
                  spec: { replicas: 2, selector: { matchLabels: { app: 'api' } }, template: { spec: { containers: [{ image: 'ghcr.io/acme/api:1.4.2' }] } } },
                  status: { readyReplicas: 1, conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable' }] },
                },
              ],
            }),
          )
        if (a.kind === 'pods')
          return text(
            JSON.stringify({
              items: [...w.pods, api3, migrate, { metadata: { name: 'job-x', namespace: 'payments', labels: {} }, spec: {}, status: { phase: 'Succeeded' } }],
            }),
          )
        return fail('unexpected kind')
      case 'k8s_logs':
        return text(a.previous ? 'previous run\nOOM: killed' : 'line1\nline2 password=s3cr3t')
      case 'k8s_events':
        return text([
          { type: 'Warning', reason: 'BackOff', object: 'payments/Pod/api-2', message: 'Back-off restarting failed container', count: 12, last: '2026-11-26T10:00:00Z' },
          { type: 'Normal', reason: 'Pulled', object: 'payments/Pod/api-1', message: 'Image pulled', count: 1, last: '2026-11-26T09:00:00Z' },
        ])
      case 'k8s_describe':
        return text(`Name:  ${a.name}\nNamespace:  ${a.namespace ?? ''}\nKind: ${a.kind}`)
      case 'argo_apps':
        if (!w.argoInstalled) return fail('kubectl: exit status 1: error: the server doesn\'t have a resource type "applications"')
        return text([
          { name: 'web', project: 'default', sync: 'Synced', health: 'Healthy', autoSync: true, autoPrune: false },
          { name: 'payments', project: 'default', sync: 'OutOfSync', health: 'Degraded', autoSync: true, autoPrune: false },
        ])
      case 'argo_app_tree':
        return text({ app: { name: a.name }, resources: [{ kind: 'Deployment', name: 'api', namespace: 'payments', sync: 'Synced', health: 'Degraded', message: 'progress deadline exceeded' }] })
      case 'rca_collect':
        return text({
          context: a.context ?? CTX,
          findings: [{ severity: 9, object: 'pod/api-2/app', signal: 'CrashLoopBackOff', detail: 'back-off (image ghcr.io/acme/api:1.4.2)' }],
          recentWarnings: [{ type: 'Warning', reason: 'BackOff', object: 'payments/Pod/api-2', message: 'Back-off', count: 12, last: '2026-11-26T10:00:00Z' }],
          hint: 'correlate',
          // what opened and resolved since the last collection (the monitor's alerts)
          opened: w.opened.splice(0),
          resolved: w.resolved.splice(0),
        })
      case 'rca_history':
        return text(w.history)
      case 'fleet_status':
        return text([
          { context: 'eks-prod', tier: 'prod', reachable: true, nodes: 3, nodesReady: 3, pods: 40, podsFailing: 0, podsNotReady: 0, warnings15m: 0, argoInstalled: true, argoApps: 4, argoDegraded: 0, argoOutOfSync: 0, topProblems: [] },
          { context: CTX, tier: 'dev', reachable: true, nodes: 3, nodesReady: 2, pods: 12, podsFailing: 2, podsNotReady: 1, warnings15m: 5, argoInstalled: true, argoApps: 2, argoDegraded: 1, argoOutOfSync: 0, topProblems: ['node/k3d-agent-2: NotReady', 'payments/pod/api-2: CrashLoopBackOff'] },
        ])
      case 'security_overview':
        return text({
          context: a.context,
          summary: { high: 1, medium: 1, low: 0 },
          checks: [
            { id: 'privileged', title: 'privileged containers', severity: 'high', count: 1, objects: ['payments/deployment/api'], advice: 'Drop privileged: true.' },
            { id: 'no-network-policy', title: 'namespaces without a NetworkPolicy', severity: 'medium', count: 1, objects: ['payments/namespace/payments'], advice: 'Add a default-deny policy.' },
          ],
          note: 'Read-only posture checks.',
        })
      case 'incident_list':
        return text(a.status === 'active' ? w.incidents.filter(i => i.status !== 'resolved') : w.incidents)
      case 'incident_open': {
        const inc: Incident = {
          id: `INC-${w.incidents.length + 1}`,
          title: String(a.title),
          severity: String(a.severity),
          status: 'open',
          context: String(a.context ?? ''),
          namespace: String(a.namespace ?? ''),
          objects: String(a.objects ?? '').split(',').filter(Boolean),
          openedAt: new Date().toISOString(),
          timeline: [{ at: new Date().toISOString(), by: String(a.by), kind: 'opened', text: 'opened: ' + a.title }],
        }
        w.incidents.unshift(inc)
        return text(inc)
      }
      case 'incident_note':
      case 'incident_status': {
        const inc = w.incidents.find(i => i.id === a.id)
        if (!inc) return fail('no incident ' + a.id)
        if (e.tool === 'incident_status') inc.status = String(a.status)
        inc.timeline.push({ at: new Date().toISOString(), by: String(a.by), kind: e.tool === 'incident_status' ? 'status' : String(a.kind ?? 'note'), text: String(a.text ?? a.status) })
        return text(inc)
      }
    }
    return fail('unknown tool ' + e.tool)
  })
  on('process.run', (_, e) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // Steve's voice and ears, apart from the k8sh runs the tests count
    if (e.argv[0] === 'say') return ok(w.installed)
    if (e.argv[0] === '/bin/sh' && e.argv[1] === '-c') {
      const found = w.bins[String(e.argv[3])]
      return found ? ok(found + '\n') : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === '/bin/rm') return ok('')
    if (Object.values(w.bins).includes(String(e.argv[0]))) {
      w.speechRuns.push(e.argv)
      if (e.argv[0] === w.bins.piper) w.piped.push((e as { init?: { stdin?: string } }).init?.stdin)
      return ok(e.argv[0] === w.bins['whisper-cli'] ? w.transcript : '')
    }
    w.runs.push(e)
    if (e.argv[1] === 'ui-init') return ok('/home/u/.k8sh/ui.token\n')
    if (e.argv[1] === 'grant-from-ui') {
      w.grants.push({ Context: CTX, Namespace: 'payments', Action: 'delete', Target: 'pod/api-2', ExpiresIn: '9m59s' })
      return ok(JSON.stringify({ id: 'ab12cd34ef56ab78', context: CTX, namespace: 'payments', action: 'delete', target: 'pod/api-2', expiresAt: '2026-11-26T10:10:00Z', tier: 'dev' }) + '\n')
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => ({ value: String(e.path).endsWith('/.claude-plugin/plugin.json') ? '{"name":"devops-assistant","version":"9.8.7"}' : 'f'.repeat(64) + '\n' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return w
}

type Ui = Awaited<ReturnType<Parameters<Parameters<typeof test>[1]>[0]['ui']['mount']>>

async function openPane($: Parameters<Parameters<typeof test>[1]>[0], on: On, surface: 'terminal' | 'desktop' = 'terminal') {
  const w = world(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  await $.command.run({ command: 'k8s' })
  await clock.advance(1)
  const ui = await $.ui.mount({ ...PANE, surface })
  return { w, clock, ui }
}

const row = (ui: Ui, id: string) => ui.find({ key: 'row:' + id })
const tool = (w: World, name: string) => w.calls.filter(c => c.tool === name)

test('opens on every tab, with contexts, tiers and the lock state', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'k8s' })
    await clock.advance(1)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'tab:cluster' }))?.props.hotkey).toBe('1')
    expect(await ui.find({ type: 'Select', key: 'context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'LOCKED' })).toBeDefined()
    expect(w.status.text).toBe('k8s k3d-mycluster [dev] LOCKED')
    expect((await row(ui, NS))?.text).toContain('payments')
    expect(await row(ui, 'cluster/ns:kube-system')).toBeDefined()

    await ui.press({ key: 'tab:argo' })
    // problems first
    const apps = await ui.findAll({ type: 'Button', text: /OutOfSync|Synced\// })
    expect(apps[0]?.text).toContain('payments  OutOfSync/Degraded')
    expect((await row(ui, 'argo/app:web'))?.text).toContain('Synced/Healthy')

    await ui.press({ key: 'tab:rca' })
    expect((await row(ui, 'rca/f:0'))?.text).toContain('[9] CrashLoopBackOff  pod/api-2/app')
    expect((await row(ui, 'rca/warnings'))?.text).toContain('recent warnings (1)')

    await ui.press({ key: 'tab:lock' })
    expect((await row(ui, 'lock/state'))?.text).toContain('LOCKED in k3d-mycluster')
    expect((await row(ui, 'lock/c:eks-prod'))?.text).toContain('eks-prod [prod]')

    await ui.press({ key: 'tab:cluster' })
    expect(await row(ui, NS)).toBeDefined()
    await ui.unmount()
    await $.command.run({ command: 'k8s' })
  }
  expect(w.closed).toBe(2)
})

test('a row press selects, a second press expands, a third collapses', async ($, on) => {
  const { w, ui } = await openPane($, on)
  await ui.press({ key: 'row:' + NS })
  expect(await ui.find({ type: 'Text', text: 'Namespace payments' })).toBeDefined()
  expect(await row(ui, DEPLOY)).toBeUndefined()

  await ui.press({ key: 'row:' + NS })
  expect(tool(w, 'k8s_get').map(c => c.args.kind)).toEqual(expect.arrayContaining(['deployments,statefulsets,daemonsets', 'pods']))
  expect((await row(ui, DEPLOY))?.text).toContain('deploy/api  1/2')
  expect((await row(ui, NS + '/pod:job-x'))?.text).toContain('pod/job-x  Succeeded')
  expect(await row(ui, POD)).toBeUndefined()

  await ui.press({ key: 'row:' + DEPLOY })
  await ui.press({ key: 'row:' + DEPLOY })
  expect((await row(ui, POD))?.text).toContain('pod/api-2  Running OOMKilled r:7')
  expect((await row(ui, POD))?.text).toContain('✖')

  await ui.press({ key: 'row:' + POD })
  await ui.press({ key: 'row:' + POD })
  expect((await row(ui, CONTAINER))?.text).toContain('app  CrashLoopBackOff  r:7')

  await ui.press({ key: 'row:' + NS })
  await ui.press({ key: 'row:' + NS })
  expect(await row(ui, DEPLOY)).toBeUndefined()
  expect(await row(ui, POD)).toBeUndefined()
  await ui.unmount()
})

test('the Argo CD tab expands an app into its resources, or says Argo CD is missing', async ($, on) => {
  const { w, ui } = await openPane($, on)
  await ui.press({ key: 'tab:argo' })
  await ui.press({ key: 'row:argo/app:payments' })
  await ui.press({ key: 'row:argo/app:payments' })
  expect(tool(w, 'argo_app_tree')[0]?.args).toMatchObject({ name: 'payments', context: CTX })
  expect((await row(ui, 'argo/app:payments/Deployment:payments:api'))?.text).toContain('Deployment/api  Synced/Degraded')

  w.argoInstalled = false
  await ui.press({ key: 'act:refresh' })
  expect((await row(ui, 'argo/none'))?.text).toContain('Argo CD not installed in this context')
  await ui.unmount()
})

async function selectPod(ui: Ui) {
  for (const id of [NS, NS, DEPLOY, DEPLOY, POD]) await ui.press({ key: 'row:' + id })
}

test('the breadcrumb jumps back; ⌂ collapses everything', async ($, on) => {
  const { ui } = await openPane($, on)
  await selectPod(ui)
  const crumbs = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('crumb:')).map(b => b.text)
  expect(crumbs).toEqual(['⌂', 'Cluster', 'payments', 'deploy/api', 'pod/api-2'])

  await ui.press({ key: 'crumb:' + NS })
  expect(await ui.find({ type: 'Text', text: 'Namespace payments' })).toBeDefined()
  expect(await row(ui, DEPLOY)).toBeDefined()
  expect(await row(ui, POD)).toBeUndefined()

  await ui.press({ key: 'crumb:top' })
  expect(await row(ui, DEPLOY)).toBeUndefined()
  expect(await ui.find({ key: 'crumb:' + NS })).toBeUndefined()
  await ui.unmount()
})

test('Back steps up a level and Top goes to the top level', async ($, on) => {
  const { ui } = await openPane($, on)
  await selectPod(ui)
  await ui.press({ key: 'act:back' })
  expect(await ui.find({ key: 'crumb:' + DEPLOY })).toBeDefined()
  expect(await ui.find({ key: 'crumb:' + POD })).toBeUndefined()
  expect(await row(ui, POD)).toBeUndefined()
  expect(await row(ui, DEPLOY)).toBeDefined()

  await ui.press({ key: 'act:top' })
  expect(await row(ui, DEPLOY)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Press a row to select it/ })).toBeDefined()
  await ui.unmount()
})

test('Logs, Prev logs, Events and Describe show in the detail, and ✕ closes it', async ($, on) => {
  const { w, ui } = await openPane($, on)
  await selectPod(ui)
  expect(await ui.find({ key: 'act:unlock' })).toBeDefined()

  await ui.press({ key: 'act:logs' })
  expect(tool(w, 'k8s_logs')[0]?.args).toMatchObject({ pod: 'api-2', namespace: 'payments', context: CTX, previous: false })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('line1')

  await ui.press({ key: 'act:prev' })
  expect(tool(w, 'k8s_logs')[1]?.args).toMatchObject({ previous: true })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('OOM: killed')

  await ui.press({ key: 'act:events' })
  expect(tool(w, 'k8s_events')[0]?.args).toMatchObject({ namespace: 'payments', warningsOnly: false })
  const events = (await ui.find({ type: 'Code' }))?.text ?? ''
  expect(events).toContain('BackOff  payments/Pod/api-2')
  expect(events).toContain('(x12)')
  expect(events).not.toContain('api-1')

  await ui.press({ key: 'act:describe' })
  expect(tool(w, 'k8s_describe')[0]?.args).toMatchObject({ kind: 'Pod', name: 'api-2', namespace: 'payments', context: CTX })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('Name:  api-2')

  await ui.press({ key: 'detail-close' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Pod payments/api-2' })).toBeDefined()

  // a container's logs name the container; its describe is the pod's
  await ui.press({ key: 'row:' + POD })
  await ui.press({ key: 'row:' + CONTAINER })
  await ui.press({ key: 'act:logs' })
  expect(tool(w, 'k8s_logs')[2]?.args).toMatchObject({ pod: 'api-2', container: 'app' })
  expect(await ui.find({ key: 'act:unlock' })).toBeUndefined()

  // a namespace has Events and Describe, no logs
  await ui.press({ key: 'crumb:' + NS })
  expect(await ui.find({ key: 'act:logs' })).toBeUndefined()
  await ui.press({ key: 'act:describe' })
  expect(tool(w, 'k8s_describe')[1]?.args).toMatchObject({ kind: 'namespace', name: 'payments' })
  expect(w.runs).toHaveLength(0)
  await ui.unmount()
})

test('Ask Claude submits a short, redacted description as the person', async ($, on) => {
  const { w, ui } = await openPane($, on)
  await selectPod(ui)
  await ui.press({ key: 'act:logs' })
  await ui.press({ key: 'act:ask' })
  expect(w.submitted).toHaveLength(1)
  const sent = w.submitted[0]
  expect(sent?.origin).toMatchObject({ kind: 'plugin', asUser: true })
  const text = sent?.text ?? ''
  expect(text).toContain('rca-runbook')
  expect(text).toContain('context: k3d-mycluster [dev] (lock: LOCKED)')
  expect(text).toContain('namespace: payments')
  expect(text).toContain('object: pod/api-2')
  expect(text).toContain('logs api-2')
  expect(text).toContain('line1')
  expect(text).not.toContain('s3cr3t')
  expect(text.length).toBeLessThan(6001)
  expect(await ui.find({ type: 'Text', text: /Sent to Claude/ })).toBeDefined()
  await ui.unmount()
})

test('Unlock… refuses a wrong context name and grants on the exact one', async ($, on) => {
  const { w, ui } = await openPane($, on)
  await selectPod(ui)
  await ui.press({ key: 'act:unlock' })
  expect(await ui.find({ type: 'Text', text: 'Type the context name to allow ONE delete on pod/api-2:' })).toBeDefined()
  expect(await ui.find({ key: 'unlock-action:scale-zero' })).toBeUndefined()

  for (const typed of ['k3d', 'K3D-MYCLUSTER', 'k3d-mycluster ', 'eks-prod', '']) {
    await ui.input({ key: 'unlock-confirm', text: typed })
    expect(await ui.find({ type: 'Text', text: /That is not "k3d-mycluster"\. Nothing was unlocked\./ })).toBeDefined()
  }
  expect(w.runs).toHaveLength(0)
  expect(w.status.text).toBe('k8s k3d-mycluster [dev] LOCKED')

  await ui.input({ key: 'unlock-confirm', text: CTX })
  expect(w.runs.map(r => r.argv[1])).toEqual(['ui-init', 'grant-from-ui'])
  const grant = w.runs[1]
  expect(grant?.argv[0]).toMatch(/\/bin\/k8sh-launch$/)
  expect(grant?.argv.slice(2)).toEqual(['--context', CTX, '--namespace', 'payments', '--action', 'delete', '--target', 'pod/api-2', '--confirm', CTX])
  expect(grant?.init?.stdin).toBe('f'.repeat(64) + '\n')
  expect(await ui.find({ type: 'Text', text: /🔓 granted ab12cd34ef56ab78: ONE delete on pod\/api-2/ })).toBeDefined()
  expect(await ui.find({ key: 'unlock-confirm' })).toBeUndefined()
  expect(w.status.text).toBe('k8s k3d-mycluster [dev] UNLOCKED x1')
  expect(await ui.find({ type: 'Text', text: 'UNLOCKED x1' })).toBeDefined()
  await ui.unmount()
})

test('a deployment offers delete or scale-zero', async ($, on) => {
  const { w, ui } = await openPane($, on)
  for (const id of [NS, NS, DEPLOY]) await ui.press({ key: 'row:' + id })
  await ui.press({ key: 'act:unlock' })
  await ui.press({ key: 'unlock-action:scale-zero' })
  expect(await ui.find({ type: 'Text', text: 'Type the context name to allow ONE scale-zero on deployment/api:' })).toBeDefined()
  await ui.input({ key: 'unlock-confirm', text: CTX })
  expect(w.runs[1]?.argv).toEqual(expect.arrayContaining(['--action', 'scale-zero', '--target', 'deployment/api']))
  await ui.unmount()
})

test('a k8sh tool call refreshes the open pane; /k8s again closes it', async ($, on) => {
  const { w, clock, ui } = await openPane($, on)
  const before = tool(w, 'k8s_get').length
  await $.tool.call({ tool: 'mcp__plugin_devops-assistant_k8sh__k8s_get', kind: 'pods' } as never)
  await clock.advance(1600)
  expect(tool(w, 'k8s_get').length).toBeGreaterThan(before)

  const ticks = tool(w, 'lock_status').length
  await clock.advance(15000)
  expect(tool(w, 'lock_status').length).toBeGreaterThan(ticks)

  await $.command.run({ command: 'k8s' })
  expect(w.closed).toBe(1)
  const after = w.calls.length
  await clock.advance(45000)
  expect(w.calls.length).toBe(after)
  await ui.unmount()
})

test('/devops-assistant:ui opens the same pane', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'devops-assistant:ui' })
  expect(out.text).toContain('k8s pane open')
  expect(w.closed).toBe(0)
})

/** The glyphs of a Raster's cells, row after row. */
function glyphsOf(cells: string | undefined) {
  const bin = atob(String(cells))
  let s = ''
  for (let i = 0; i < bin.length; i += 12) s += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
  return s
}
const shown = (w: World) => glyphsOf(w.blits.at(-1)?.cells)

test('the backdrop: Steve by default, then ∞, then off, from the look button; none on desktop', async ($, on) => {
  const { w, clock, ui } = await openPane($, on)
  const raster = await ui.find({ type: 'Raster', key: 'backdrop' })
  expect(raster?.props).toMatchObject({ columns: 70, rows: 60 })
  // 70 x 60 cells of three u32 each, base64
  expect(String(raster?.props.cells).length).toBe(Math.ceil((70 * 60 * 12) / 3) * 4)
  // Steve in half blocks, the name and version from plugin.json under him
  expect(glyphsOf(raster?.props.cells as string)).toContain('▀')
  expect(glyphsOf(raster?.props.cells as string)).toContain('devops-assistant v9.8.7')
  expect((await ui.find({ key: 'look' }))?.text).toContain('Steve')

  // the ∞ turns on every frame
  await ui.press({ key: 'look' })
  expect((await ui.find({ key: 'look' }))?.text).toContain('∞')
  expect(await ui.find({ key: 'voice' })).toBeUndefined()
  const before = w.blits.length
  await clock.advance(83 * 4)
  expect(w.blits.length - before).toBeGreaterThanOrEqual(3)
  expect(w.blits.every(b => b.requestId === 'k8s' && b.key === 'backdrop' && b.columns === 70 && b.rows === 60)).toBe(true)
  expect(new Set(w.blits.slice(before).map(b => b.cells)).size).toBeGreaterThan(1)
  expect(shown(w)).toContain('devops-assistant v9.8.7')

  // off: no Raster, no frames
  await ui.press({ key: 'look' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  const n = w.blits.length
  await clock.advance(2000)
  expect(w.blits.length).toBe(n)

  await ui.press({ key: 'look' })
  expect(await ui.find({ type: 'Raster', key: 'backdrop' })).toBeDefined()
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  expect(await desk.find({ key: 'look' })).toBeUndefined()
  await desk.unmount()
})

test('Steve reads no answers unless asked: canned lines, no model call, no marker', async ($, on) => {
  const { w, clock, ui } = await openPane($, on)
  expect(await ui.find({ type: 'Text', text: /reads answers/ })).toBeUndefined()
  await $.turn.complete({ turnId: 't1', answer: 'The api-2 pod is OOMKilled. Raise its memory limit.', durationMs: 5, isAborted: false, reason: 'answered' } as never)
  await clock.advance(83 * 2)
  expect(w.asked).toEqual([])
  expect(linesFor('done', true).some(l => shown(w).includes(l))).toBe(true)
  expect(shown(w)).not.toContain('OOMKilled')
  await ui.unmount()
})

test('grumpy Steve (reading answers, opted in): listens, names the tool, reacts to the answer in his own words, speaks with voice on, swears at a new problem', { options: { steveReadsAnswers: true } }, async ($, on) => {
  const { w, clock, ui } = await openPane($, on)
  // while he reads answers, the pane says so
  expect(await ui.find({ type: 'Text', text: /reads answers \(haiku\)/ })).toBeDefined()
  // a grumpy greeting, not said aloud
  await clock.advance(83 * 2)
  expect(linesFor('greet', true).some(l => shown(w).includes(l))).toBe(true)

  // typing: sound rings by his headphones
  await $.prompt.edit({ origin: { kind: 'composer' }, text: 'why is', cursor: 6, start: 6, end: 6, inputText: ' a' })
  await clock.advance(83 * 2)
  expect(shown(w)).toContain('╲')

  // a turn: thinking, the tool in his bubble, never its arguments' values
  await $.turn.start({ turnId: 't1' } as never)
  await $.tool.call({ tool: 'mcp__plugin_devops-assistant_k8sh__k8s_get', kind: 'pods', namespace: 'payments' } as never)
  await clock.advance(83 * 2)
  expect(shown(w)).toContain('checking pods… again')
  expect(shown(w)).not.toContain('payments')

  // the answer: haiku gets it redacted with the salty persona; his line, not the answer, in the bubble
  await $.turn.complete({ turnId: 't1', answer: 'The api-2 pod is OOMKilled, password s3cr3t. Raise its memory limit.', durationMs: 5, isAborted: false, reason: 'answered' } as never)
  await clock.advance(83 * 2)
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0].model).toBe('haiku')
  expect(w.asked[0].system).toBe(persona(true))
  expect(String(w.asked[0].prompt)).toContain('[REDACTED]')
  expect(String(w.asked[0].prompt)).not.toContain('s3cr3t')
  expect(shown(w)).toContain('Of course it got OOMKilled.')
  expect(shown(w)).not.toContain('Raise its memory limit')
  expect(w.spoken).toEqual([])

  // voice on: a grumpy line, then his take on the next answer, in Rocko's voice
  await ui.press({ key: 'voice' })
  expect((await ui.find({ key: 'voice' }))?.text).toContain('voice on')
  // (a chatty model is cut to two sentences)
  w.quip = 'Healthy. For now. Do not touch anything.'
  await $.turn.complete({ turnId: 't2', answer: 'All pods are healthy now.', durationMs: 5, isAborted: false, reason: 'answered' } as never)
  expect(w.spoken).toHaveLength(2)
  expect(linesFor('voiceOn', true)).toContain(w.spoken[0])
  expect(w.spoken[1]).toBe('Healthy. For now.')
  expect(w.voices).toEqual(['Rocko (English (US))', 'Rocko (English (US))'])

  // a more natural voice downloaded since: auto takes it the next time voice is turned on
  w.installed += 'Somevoice (Enhanced) en_GB    # Hello! My name is Somevoice.\n'
  await ui.press({ key: 'voice' })
  await ui.press({ key: 'voice' })
  expect(w.voices.at(-1)).toBe('Somevoice (Enhanced)')
  w.spoken.length = 2
  w.voices.length = 2

  // no answer from the model: a canned grumpy line
  w.quip = ''
  await $.turn.complete({ turnId: 't3', answer: 'Done.', durationMs: 5, isAborted: false, reason: 'answered' } as never)
  expect(linesFor('done', true)).toContain(w.spoken[2])

  // a problem the pane had not shown before: a facepalm and a salty line naming it
  for (const id of [NS, NS, DEPLOY, DEPLOY]) await ui.press({ key: 'row:' + id })
  // (the k8s_get call above booked a refresh 1.5 s later; its k8sh calls settle over a few ticks)
  await clock.advance(2000)
  for (let i = 0; i < 16 && !shown(w).includes('pod/api-2'); i++) await clock.advance(250)
  expect(shown(w)).toContain('pod/api-2')
  // seen once: the next refresh says nothing new
  await clock.advance(15000)
  expect(shown(w)).not.toContain('pod/api-2')
  await ui.unmount()
})

test('auto voice: Premium, then Enhanced, English only, else Rocko', () => {
  const builtIn = 'Fred                en_US    # Hello!\nRocko (English (US)) en_US    # Hello!\n'
  expect(autoVoice(builtIn)).toBe('Rocko (English (US))')
  expect(autoVoice(builtIn + 'Marie (Premium)     fr_FR    # Bonjour\n')).toBe('Rocko (English (US))')
  expect(autoVoice(builtIn + 'Aaa (Enhanced)      en_US    # Hi\n')).toBe('Aaa (Enhanced)')
  expect(autoVoice(builtIn + 'Aaa (Enhanced)      en_US    # Hi\nBbb (Premium)       en_GB    # Hi\n')).toBe('Bbb (Premium)')
})

test('Steve’s persona: grumpy either way, mild swearing only when salty', () => {
  expect(persona(true)).toContain('crap')
  expect(persona(true)).toContain('No slurs, no f-word')
  expect(persona(false)).toContain('No swearing at all')
  for (const l of linesFor('broke', false)) expect(l).not.toMatch(/crap|damn|hell/i)
  for (const l of linesFor('broke', true)) expect(l).toContain('{x}')
})

test('namespaces carry their pods’ health, broken first; owners, Jobs, init containers, age and last restart are read', async ($, on) => {
  const { w, ui } = await openPane($, on)
  // one all-namespaces pods call gives the counts
  expect(tool(w, 'k8s_get').some(c => c.args.kind === 'pods' && c.args.allNamespaces === true)).toBe(true)
  expect((await row(ui, NS))?.text).toContain('payments  ✖2')
  expect((await row(ui, 'cluster/ns:kube-system'))?.text).not.toContain('✖')
  const order = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('row:cluster/ns:'))
  expect(order).toEqual(['row:' + NS, 'row:cluster/ns:kube-system'])

  // Ask Claude with nothing selected names the broken namespace
  await ui.press({ key: 'act:ask' })
  expect(w.submitted.at(-1)?.text).toContain('✖ payments  ✖2')

  for (const id of [NS, NS, DEPLOY, DEPLOY]) await ui.press({ key: 'row:' + id })
  // in deploy/api by its ReplicaSet owner, though it has no app label; restarts with when, and age
  const a3 = (await row(ui, DEPLOY + '/pod:api-3'))?.text
  expect(a3).toContain('r:3 (last 5m ago)')
  expect(a3).toContain('age 2d')
  // a Job's pods under the Job; the init container's crash is the reason
  expect((await row(ui, NS + '/Job:migrate'))?.text).toContain('job/migrate  0/1 succeeded')
  await ui.press({ key: 'row:' + NS + '/Job:migrate' })
  await ui.press({ key: 'row:' + NS + '/Job:migrate' })
  const mig = await row(ui, NS + '/Job:migrate/pod:migrate-x7')
  expect(mig?.text).toContain('Pending Init:CrashLoopBackOff r:4')
  expect(mig?.text).toContain('✖')
  await ui.press({ key: 'row:' + NS + '/Job:migrate/pod:migrate-x7' })
  await ui.press({ key: 'row:' + NS + '/Job:migrate/pod:migrate-x7' })
  expect((await row(ui, NS + '/Job:migrate/pod:migrate-x7/c:wait-db'))?.text).toContain('init:wait-db  CrashLoopBackOff  r:4')
  await ui.unmount()

  // the widget counts pods, not namespaces
  const widget = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect(await widget.find({ type: 'Text', text: '2 error · 0 warning' })).toBeDefined()
  await widget.unmount()
})

test('filter and problems only narrow the tree; actions sit above it; it trims while a detail is open; a replaced pod falls back to its workload', async ($, on) => {
  const { w, ui } = await openPane($, on)
  // the filter narrows the top level as you type
  await ui.input({ key: 'filter', text: 'kube', kind: 'change' })
  expect(await row(ui, NS)).toBeUndefined()
  expect(await row(ui, 'cluster/ns:kube-system')).toBeDefined()
  await ui.input({ key: 'filter', text: 'zzz', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /nothing matches/ })).toBeDefined()
  await ui.press({ key: 'filter-clear' })
  // problems only hides ✔ rows
  await ui.press({ key: 'problems' })
  expect(await row(ui, NS)).toBeDefined()
  expect(await row(ui, 'cluster/ns:kube-system')).toBeUndefined()
  await ui.press({ key: 'problems' })
  expect(await row(ui, 'cluster/ns:kube-system')).toBeDefined()

  // the actions come before the tree
  const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  expect(keys.indexOf('act:refresh')).toBeGreaterThanOrEqual(0)
  expect(keys.indexOf('act:refresh')).toBeLessThan(keys.indexOf('row:' + NS))

  // many pods: with api-2's logs open, the tree shows only the rows around it
  w.pods = [...w.pods, ...Array.from({ length: 14 }, (_, i) => pod(`api-x${i}`, '', 0, ''))]
  for (const id of [NS, NS, DEPLOY, DEPLOY, POD]) await ui.press({ key: 'row:' + id })
  const all = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('row:')).length
  await ui.press({ key: 'act:logs' })
  const trimmed = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('row:')).length
  expect(all).toBeGreaterThan(12)
  expect(trimmed).toBeLessThanOrEqual(12)
  expect(await row(ui, POD)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rows below/ })).toBeDefined()
  await ui.press({ key: 'detail-close' })

  // a rollout replaces api-2: the selection falls back to deploy/api, and the pane says so
  w.pods = [pod('api-1', '', 0, ''), pod('api-9', '', 0, '')]
  await ui.press({ key: 'act:refresh' })
  expect(await ui.find({ key: 'crumb:' + POD })).toBeUndefined()
  expect(await ui.find({ key: 'crumb:' + DEPLOY })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pod\/api-2 is gone/ })).toBeDefined()
  await ui.unmount()
})

test('Steve speaks with Piper when it is installed, and hears you through whisper.cpp when you press 🎤 talk', async ($, on) => {
  const { w, ui } = await openPane($, on)
  // not installed: 🎤 says what is missing, and nothing records
  await ui.press({ key: 'talk' })
  expect(await ui.find({ type: 'Text', text: /Steve can't hear yet: he needs ffmpeg, whisper-cli/ })).toBeDefined()
  expect(w.spawned).toEqual([])

  w.bins = { piper: '/u/.local/bin/piper', ffmpeg: '/opt/homebrew/bin/ffmpeg', 'whisper-cli': '/opt/homebrew/bin/whisper-cli' }
  w.exists = true

  // voice on: the line goes to Piper and afplay, not to say
  await ui.press({ key: 'voice' })
  expect(w.piped).toHaveLength(1)
  expect(linesFor('voiceOn', true)).toContain(w.piped[0])
  expect(w.speechRuns.find(a => a[0] === w.bins.piper)).toContain('-m')
  expect(w.spawned.some(a => a[0] === '/usr/bin/afplay')).toBe(true)
  expect(w.spoken).toEqual([])

  // 🎤: ffmpeg records the default microphone until a pause after speech, whisper turns it into text, into the prompt box
  w.mic = ['size=N/A time=00:00:00.50\n', '[silencedetect @ 0x1] silence_start: 0\n', '[silencedetect @ 0x1] silence_end: 0.9 | silence_duration: 0.9\n', 'size=N/A time=00:00:02.00\n', '[silencedetect @ 0x1] silence_start: 2.4\n']
  w.transcript = ' Why is api-2 crash looping? [BLANK_AUDIO]\n'
  await ui.press({ key: 'talk' })
  const rec = w.spawned.find(a => a[0] === w.bins.ffmpeg) ?? []
  expect(rec).toEqual(expect.arrayContaining(['-f', 'avfoundation', '-i', ':default', '-t', '30']))
  expect(w.speechRuns.find(a => a[0] === w.bins['whisper-cli'])).toEqual(expect.arrayContaining(['-l', 'en']))
  expect(w.filled).toEqual(['Why is api-2 crash looping?'])
  expect(w.submitted.map(s => s.text)).not.toContain('Why is api-2 crash looping?')
  expect((await ui.find({ key: 'talk' }))?.text).toContain('talk')

  // too short to be speech: nothing goes in, and he says so
  w.recorded = 100
  await ui.press({ key: 'talk' })
  expect(w.filled).toHaveLength(1)
  await ui.unmount()
})

test('Fleet: every context at a glance, troubled first; Switch to; the background refresh spares it', async ($, on) => {
  const { w, clock, ui } = await openPane($, on)
  await ui.press({ key: 'tab:fleet' })
  expect((await ui.find({ key: 'tab:fleet' }))?.props.hotkey).toBe('5')
  const order = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('row:fleet/ctx:'))
  expect(order).toEqual(['row:fleet/ctx:' + CTX, 'row:fleet/ctx:eks-prod'])
  const mine = (await row(ui, 'fleet/ctx:' + CTX))?.text
  expect(mine).toContain('✖ k3d-mycluster [dev]  pods ✖2 ⚠1  nodes 2/3  argo ✖1 ⚠0')
  await ui.press({ key: 'row:fleet/ctx:' + CTX })
  expect(await ui.find({ type: 'Text', text: 'warning events, last 15 min: 5' })).toBeDefined()
  await ui.press({ key: 'row:fleet/ctx:' + CTX })
  expect((await row(ui, 'fleet/ctx:eks-prod'))?.text).toContain('pods ✔40  nodes 3/3  argo ✔')
  await ui.press({ key: 'row:fleet/ctx:' + CTX })
  await ui.press({ key: 'row:fleet/ctx:' + CTX })
  expect((await row(ui, `fleet/ctx:${CTX}/p:0`))?.text).toContain('node/k3d-agent-2: NotReady')
  await ui.press({ key: 'row:fleet/ctx:' + CTX })

  // cluster-wide: the 15 s refresh doesn't reload it; ⟳ does
  const n = tool(w, 'fleet_status').length
  await clock.advance(15000)
  expect(tool(w, 'fleet_status').length).toBe(n)
  await ui.press({ key: 'act:refresh' })
  expect(tool(w, 'fleet_status').length).toBe(n + 1)

  // Switch to: that context, in the Cluster tab
  await ui.press({ key: 'row:fleet/ctx:eks-prod' })
  await ui.press({ key: 'act:switch' })
  expect(await ui.find({ key: 'tab:cluster' })).toBeDefined()
  expect(tool(w, 'k8s_get').at(-1)?.args.context).toBe('eks-prod')
  await ui.unmount()
})

test('Security: checks worst first, each listing the workloads that break it, ready for Describe', async ($, on) => {
  const { w, ui } = await openPane($, on)
  await ui.press({ key: 'tab:security' })
  expect(tool(w, 'security_overview')[0]?.args).toMatchObject({ context: CTX })
  expect((await row(ui, 'security/summary'))?.text).toContain('checks failing: 1 high · 1 medium · 0 low')
  expect((await row(ui, 'security/check:privileged'))?.text).toContain('HIGH  privileged containers (1)')
  await ui.press({ key: 'row:security/check:privileged' })
  await ui.press({ key: 'row:security/check:privileged' })
  const obj = 'security/check:privileged/o:payments/deployment/api'
  expect((await row(ui, obj))?.text).toContain('payments/deployment/api')
  await ui.press({ key: 'row:' + obj })
  await ui.press({ key: 'act:describe' })
  expect(tool(w, 'k8s_describe').at(-1)?.args).toMatchObject({ kind: 'Deployment', name: 'api', namespace: 'payments' })
  await ui.unmount()
})

test('RCA history: open and resolved problems of the last 7 days in the RCA tab', async ($, on) => {
  const { w, ui } = await openPane($, on)
  w.history = [
    { context: CTX, namespace: 'payments', object: 'pod/api-2/app', signal: 'CrashLoopBackOff', severity: 9, firstSeen: ago(3 * 3600e3), lastSeen: ago(0), seen: 40, times: 2, detail: 'back-off' },
    { context: CTX, namespace: 'payments', object: 'pod/api-1/app', signal: 'OOMKilled', severity: 9, firstSeen: ago(26 * 3600e3), lastSeen: ago(25 * 3600e3), seen: 3, times: 1, resolvedAt: ago(25 * 3600e3) },
  ]
  await ui.press({ key: 'tab:rca' })
  expect(tool(w, 'rca_history')[0]?.args).toMatchObject({ context: CTX, days: 7 })
  expect((await row(ui, 'rca/history'))?.text).toContain('history, 7 days: 1 open · 1 resolved')
  await ui.press({ key: 'row:rca/history' })
  await ui.press({ key: 'row:rca/history' })
  expect((await row(ui, 'rca/history/r:0'))?.text).toContain('✖ open  CrashLoopBackOff  payments/pod/api-2/app  since 3h ago')
  await ui.press({ key: 'row:rca/history/r:0' })
  expect(await ui.find({ type: 'Text', text: 'occurrences: 2, seen in 40 collections' })).toBeDefined()
  expect((await row(ui, 'rca/history/r:1'))?.text).toContain('resolved 25h ago  OOMKilled  payments/pod/api-1/app')
  await ui.unmount()
})

test('Incidents: open one from a problem row, note it, mitigate, resolve, ask for a postmortem', async ($, on) => {
  const { w, ui } = await openPane($, on)
  for (const id of [NS, NS, DEPLOY, DEPLOY, POD]) await ui.press({ key: 'row:' + id })
  await ui.press({ key: 'act:incident' })
  await ui.press({ key: 'sev:sev1' })
  await ui.input({ key: 'incident-title', text: 'api-2 down' })
  expect(w.incidents[0]).toMatchObject({ id: 'INC-1', title: 'api-2 down', severity: 'sev1', context: CTX, namespace: 'payments', objects: ['payments/pod/api-2'] })
  expect(w.incidents[0].timeline[0].by).toBe('pane')
  expect(await ui.find({ type: 'Text', text: /INC-1 opened \(sev1\)/ })).toBeDefined()

  // the Incidents tab opens with the active ones unfolded
  await ui.press({ key: 'tab:incidents' })
  const inc = 'incidents/active/inc:INC-1'
  expect((await row(ui, inc))?.text).toContain('INC-1 sev1 open  api-2 down')
  await ui.press({ key: 'row:' + inc })
  await ui.press({ key: 'act:note' })
  await ui.input({ key: 'incident-note', text: 'raised the memory limit in PR #12' })
  expect(w.incidents[0].timeline.at(-1)).toMatchObject({ by: 'pane', kind: 'note', text: 'raised the memory limit in PR #12' })

  await ui.press({ key: 'row:' + inc })
  await ui.press({ key: 'act:mitigate' })
  expect(w.incidents[0].status).toBe('mitigated')
  await ui.press({ key: 'row:' + inc })
  await ui.press({ key: 'act:resolve' })
  expect(w.incidents[0].status).toBe('resolved')
  const done = 'incidents/resolved/inc:INC-1'
  await ui.press({ key: 'row:incidents/resolved' })
  await ui.press({ key: 'row:incidents/resolved' })
  await ui.press({ key: 'row:' + done })
  expect(await ui.find({ key: 'act:reopen' })).toBeDefined()
  await ui.press({ key: 'act:postmortem' })
  expect(w.submitted.at(-1)?.text).toContain('blameless postmortem for incident INC-1')
  expect(w.submitted.at(-1)?.origin?.asUser).toBe(true)
  await ui.unmount()
})

test('Monitoring: off by default; on, it alerts new and resolved problems and notes them on matching incidents', async ($, on) => {
  const { w, clock, ui } = await openPane($, on)
  await ui.press({ key: 'tab:incidents' })
  expect((await ui.find({ key: 'act:monitor' }))?.text).toContain('Monitoring off')
  const before = tool(w, 'rca_collect').length
  await clock.advance(120000)
  expect(tool(w, 'rca_collect').length).toBe(before)

  w.incidents.push({ id: 'INC-7', title: 'payments flaky', severity: 'sev2', status: 'open', context: CTX, namespace: 'payments', objects: ['payments/deployment/api'], openedAt: ago(60e3), timeline: [] })
  // the first run is the baseline: one line about what is broken already, no alerts
  w.opened = [{ context: CTX, namespace: 'payments', object: 'pod/api-9/app', signal: 'CrashLoopBackOff', severity: 9 }]
  await ui.press({ key: 'act:monitor' })
  for (let i = 0; i < 20 && w.toasts.length === 0; i++) await clock.advance(50)
  expect(w.toasts[0]).toContain('◉ monitoring k3d-mycluster: 1 problem open now')
  expect(w.status.text).toContain('◉ monitoring')
  expect(w.incidents.find(i => i.id === 'INC-7')?.timeline).toEqual([])

  // a new problem at the next run: an alert
  w.toasts.length = 0
  w.opened = [{ context: CTX, namespace: 'payments', object: 'pod/api-2/app', signal: 'CrashLoopBackOff', severity: 9, detail: 'back-off' }]
  await clock.advance(60000)
  for (let i = 0; i < 20 && w.toasts.length === 0; i++) await clock.advance(50)
  expect(w.toasts[0]).toContain('✖ k3d-mycluster: CrashLoopBackOff payments/pod/api-2/app')
  expect(w.incidents.find(i => i.id === 'INC-7')?.timeline.at(-1)).toMatchObject({ by: 'monitor', kind: 'alert', text: 'alert: CrashLoopBackOff on payments/pod/api-2/app' })
  for (let i = 0; i < 20 && !(await row(ui, 'incidents/alerts/a:0')); i++) await clock.advance(50)
  expect((await row(ui, 'incidents/alerts/a:0'))?.text).toContain('✖  k3d-mycluster  payments/pod/api-2/app  CrashLoopBackOff')

  // resolved at the next run
  w.resolved = [{ context: CTX, namespace: 'payments', object: 'pod/api-2/app', signal: 'CrashLoopBackOff', severity: 9 }]
  await clock.advance(60000)
  for (let i = 0; i < 20 && w.toasts.length < 2; i++) await clock.advance(50)
  expect(w.toasts[1]).toContain('✔ resolved — k3d-mycluster: CrashLoopBackOff payments/pod/api-2/app')
  expect(w.incidents.find(i => i.id === 'INC-7')?.timeline.at(-1)?.text).toBe('resolved: CrashLoopBackOff on payments/pod/api-2/app')

  // off again: no more runs
  await ui.press({ key: 'act:monitor' })
  const runs = tool(w, 'rca_collect').length
  await clock.advance(180000)
  expect(tool(w, 'rca_collect').length).toBe(runs)
  await ui.unmount()
})

