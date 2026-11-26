// @ts-check
// Steve's personality: a grumpy, burned-out DevOps engineer. Blunt, dry, no
// pleasantries; with swearing on, mild bad words aimed at the code and the
// situation (crap, damn, hell, "who the hell wrote this"), never at anyone's
// identity, no slurs, no f-word.
//
// Pure: canned lines for what the pane sees, and the persona the model gets
// to react to Claude's answers in one line.

/**
 * The persona for reacting to an answer in one line.
 * @param {boolean} salty mild swearing allowed
 */
export function persona(salty) {
  return [
    'You are Steve, a burned-out senior DevOps engineer reading over a colleague’s shoulder.',
    'You get what the AI assistant just told them. React in ONE short line, at most 18 words.',
    'Grumpy, dry, blunt, sarcastic. No pleasantries, no praise, no "great question", no emojis, no lists, no quotes, no markdown.',
    'React to the gist only; never invent facts, names or numbers that are not in the text.',
    'Never repeat secrets, tokens, passwords or anything that looks like a credential.',
    salty
      ? 'You swear mildly when it fits: crap, damn, hell, "what the hell", "who the hell wrote this", "this is crap". Aim it at code, configs and situations, never at anyone’s identity. No slurs, no f-word.'
      : 'No swearing at all: stay grumpy and dry, but clean.',
    'Answer with the line only.',
  ].join('\n')
}

/** @typedef {'greet' | 'voiceOn' | 'stopped' | 'done' | 'granted' | 'refused' | 'wrongName' | 'broke' | 'brokeMany' | 'hearing' | 'heardNothing' | 'deaf'} Moment */

/** Canned lines by moment; {x} is the object, {n} a count. @type {Record<Moment, { clean: string[], salty: string[] }>} */
const LINES = {
  greet: {
    clean: ['What broke now?', 'Yeah, yeah. I am watching.', 'Another day, another cluster.'],
    salty: ['What the hell broke now?', 'Great. Who touched prod this time?', 'Another day, another pile of YAML crap.'],
  },
  voiceOn: {
    clean: ['Fine. I will talk. Keep it short.', 'Voice on. Do not expect pleasantries.'],
    salty: ['Fine, I will talk. Do not make me regret it.', 'Voice on. Brace yourself, this cluster is crap.'],
  },
  stopped: {
    clean: ['Stopped. Fine by me.', 'Cancelled. Whatever.'],
    salty: ['Stopped. Good, that was going to hell anyway.', 'Cancelled. Damn, finally some sense.'],
  },
  done: {
    clean: ['Done. Next.', 'There. Happy now?', 'Done. Do not touch anything.'],
    salty: ['Done. Now do not break the damn thing again.', 'There. Happy now? Hell, I am not.', 'Done. Next pile of crap, please.'],
  },
  granted: {
    clean: ['Unlocked once: {x}. Do not make me regret it.', 'One {x}. One. Then it locks again.'],
    salty: ['Unlocked once: {x}. Screw it up and it is on you.', 'One {x}, damn it. Then it locks again.'],
  },
  refused: {
    clean: ['Nope. Nothing was unlocked.', 'Refused. The lock stays.'],
    salty: ['Nope. Nothing unlocked, and good riddance.', 'Refused. Hell no, the lock stays.'],
  },
  wrongName: {
    clean: ['Wrong context name. Still locked. Read before you type.'],
    salty: ['Wrong context name, genius. Still locked.'],
  },
  broke: {
    clean: ['{x} is broken. Of course it is.', '{x}. Great. Just great.', 'Uh oh: {x}. Somebody had a busy day.'],
    salty: ['{x} is broken. Who the hell deployed this crap?', 'Uh oh: {x}. Damn it.', '{x}. What the hell is this crap?'],
  },
  brokeMany: {
    clean: ['{x}, and {n} more broken. Wonderful.', 'Uh oh: {x}, plus {n} more. Of course.'],
    salty: ['{x} and {n} more. Who created this mess?', 'Uh oh: {x}, plus {n} more. This is crap.'],
  },
  hearing: {
    clean: ['Go on. I am listening.', 'Talk. Keep it short.'],
    salty: ['Go on, I am listening. Damn it.', 'Talk. And make it quick, hell.'],
  },
  heardNothing: {
    clean: ['I did not catch a thing. Try again.', 'Nothing. Speak up.'],
    salty: ['I heard nothing. Speak up, damn it.', 'What the hell was that? Nothing. Again.'],
  },
  deaf: {
    clean: ['I cannot hear you. Allow the microphone for your terminal in System Settings, Privacy and Security, Microphone.'],
    salty: ['I am deaf, damn it. Allow the microphone for your terminal in System Settings, Privacy and Security, Microphone.'],
  },
}

let turn = 0

/**
 * A line for a moment, varied from call to call.
 * @param {Moment} moment @param {boolean} salty @param {{ x?: string, n?: number }} [fill]
 */
export function line(moment, salty, fill = {}) {
  const set = LINES[moment][salty ? 'salty' : 'clean']
  const text = set[turn++ % set.length]
  return text.replace('{x}', fill.x ?? '').replace('{n}', String(fill.n ?? ''))
}

/** Every line a moment may say (for tests). @param {Moment} moment @param {boolean} salty */
export const linesFor = (moment, salty) => LINES[moment][salty ? 'salty' : 'clean']

/**
 * What Claude is doing, from the tool it calls; names a kind, never the arguments' values.
 * @param {string} tool @param {string} kind @param {string} prefix the k8sh tools' prefix
 */
export function toolLine(tool, kind, prefix) {
  if (tool.startsWith(prefix)) {
    const t = tool.slice(prefix.length)
    if (t === 'k8s_get') return kind ? `checking ${kind}… again` : 'poking the cluster…'
    if (t === 'k8s_logs') return 'reading logs. pray for me…'
    if (t === 'k8s_events') return 'digging through events…'
    if (t === 'k8s_describe') return kind ? `describing a ${kind}…` : 'describing…'
    if (t === 'k8s_contexts') return 'which cluster now…'
    if (t === 'argo_apps' || t === 'argo_app_tree') return 'checking Argo CD…'
    if (t === 'rca_collect') return 'collecting the evidence…'
    if (t === 'validate_manifests') return 'validating your YAML…'
    if (t === 'lock_status') return 'checking the lock…'
    if (t.startsWith('destructive_')) return 'that one is locked. nice try…'
    return 'asking k8sh…'
  }
  if (tool === 'Bash') return 'running a command…'
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return 'reading the code…'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'fixing it…'
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'googling, like a pro…'
  if (tool === 'Agent' || tool === 'Task') return 'getting help…'
  return ''
}
