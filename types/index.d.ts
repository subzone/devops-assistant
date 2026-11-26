// State contract of the k8s side pane (hooks/k8s-pane.js).
// Change a `shape` tag in the module when a value's fields change.

export type K8sTab = 'cluster' | 'argo' | 'rca' | 'lock'

export type K8sStatus = 'ok' | 'warn' | 'err' | ''

/** One row of the tree. `id` is path-shaped: its parent's id + '/' + a segment. */
export type K8sNode = {
  id: string
  parent: string
  tab: K8sTab
  label: string
  status: K8sStatus
  /** Namespace, Deployment, StatefulSet, DaemonSet, Pod, Container, Application, a resource kind, Finding, Event, Grant, Context, Info */
  kind: string
  ns: string
  name: string
  /** the pod a Container belongs to */
  pod?: string
  /** a Pod's container names */
  containers?: string[]
  detail: string[]
  /** children load when it is first expanded */
  lazy: boolean
}

export type K8sDetail = { title: string; text: string }

export type K8sUnlock = {
  nodeId: string
  action: 'delete' | 'scale-zero'
  error?: string
  isBusy?: boolean
}

export type K8sNotice = { text: string; isError: boolean }

export type K8sView = {
  tab: K8sTab
  context: string | null
  expanded: string[]
  selected: string | null
  detail: K8sDetail | null
  /** rows shown under a parent id, when more than the default page */
  pages: Record<string, number>
  unlock: K8sUnlock | null
  notice: K8sNotice | null
  busy: number
  /** the ∞ backdrop's old switch: false meant off (read when `look` is absent) */
  fx?: boolean
  /** the backdrop in the docked terminal pane; absent means 'steve' */
  look?: 'steve' | 'infinity' | 'off'
  /** Steve speaks his lines aloud (macOS `say`); absent means off */
  voice?: boolean
}

export type K8sContext = { name: string; tier: string; current: boolean }

export type K8sGrant = {
  context: string
  namespace: string
  action: string
  target: string
  expiresIn: string
}

export type K8sData = {
  contexts: K8sContext[]
  grants: K8sGrant[]
  nodes: Record<string, K8sNode>
  /** child ids by parent id; a tab's own id holds its top level. Present = loaded. */
  children: Record<string, string[]>
  /** load errors by parent id ('top' for contexts/lock) */
  errors: Record<string, string>
  /** the context `nodes` were loaded for */
  loadedFor: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'devops-assistant': {
      view: Shaped<K8sView>
      data: Shaped<K8sData>
    }
  }
}
