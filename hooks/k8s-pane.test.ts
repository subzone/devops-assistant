import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A fixture cluster behind the k8sh MCP server, and the rest of the engine
// the pane reaches: panes, the status line, processes, files, the prompt.

const PANE = {
  plugin: 'k8s-handler',
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
  metadata: { name, labels: { app: 'api' } },
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

type Call = { server: string; tool: string; args: Record<string, unknown> }
type Run = { argv: readonly string[]; init?: { stdin?: string } }

type World = {
  calls: Call[]
  runs: Run[]
  submitted: { text: string; origin?: { kind: string; asUser?: boolean } }[]
  status: { text: string | undefined }
  closed: number
  grants: unknown[]
  argoInstalled: boolean
}

function world(on: On): World {
  const w: World = { calls: [], runs: [], submitted: [], status: { text: undefined }, closed: 0, grants: [], argoInstalled: true }
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
  on('session.redact', (_, e) => ({ value: e.text.replace(/s3cr3t/g, '[REDACTED]') }))
  on('prompt.submit', (_, e) => {
    w.submitted.push(e as World['submitted'][number])
    return { text: e.text }
  })
  on('tool.call', () => ({ result: {} }))
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'plugin:k8s-handler:k8sh' } }))
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
          return text(JSON.stringify({ items: [pod('api-1', '', 0, ''), pod('api-2', 'CrashLoopBackOff', 7, 'OOMKilled'), { metadata: { name: 'job-x', labels: {} }, spec: {}, status: { phase: 'Succeeded' } }] }))
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
          context: CTX,
          findings: [{ severity: 9, object: 'pod/api-2/app', signal: 'CrashLoopBackOff', detail: 'back-off (image ghcr.io/acme/api:1.4.2)' }],
          recentWarnings: [{ type: 'Warning', reason: 'BackOff', object: 'payments/Pod/api-2', message: 'Back-off', count: 12, last: '2026-11-26T10:00:00Z' }],
          hint: 'correlate',
        })
    }
    return fail('unknown tool ' + e.tool)
  })
  on('process.run', (_, e) => {
    w.runs.push(e)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[1] === 'ui-init') return ok('/home/u/.k8sh/ui.token\n')
    if (e.argv[1] === 'grant-from-ui') {
      w.grants.push({ Context: CTX, Namespace: 'payments', Action: 'delete', Target: 'pod/api-2', ExpiresIn: '9m59s' })
      return ok(JSON.stringify({ id: 'ab12cd34ef56ab78', context: CTX, namespace: 'payments', action: 'delete', target: 'pod/api-2', expiresAt: '2026-11-26T10:10:00Z', tier: 'dev' }) + '\n')
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: 'f'.repeat(64) + '\n' }))
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
  await $.tool.call({ tool: 'mcp__plugin_k8s-handler_k8sh__k8s_get', kind: 'pods' } as never)
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

test('/k8s-handler:ui opens the same pane', async ($, on) => {
  const w = world(on)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'k8s-handler:ui' })
  expect(out.text).toContain('k8s pane open')
  expect(w.closed).toBe(0)
})
