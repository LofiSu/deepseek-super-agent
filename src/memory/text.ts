/**
 * Shared text normalization for long-term memory and the optional embedding
 * port. Both paths must see the same tokens: otherwise the lexical candidate
 * space and the vector candidate space drift apart.
 *
 * The synonym/morphology map is deliberately tiny, explicit, and in-repo: no
 * learned vocabulary, no model, no external dependency.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['token', 'tokens', 'credential', 'credentials'],
  ['rotate', 'rotated', 'rotates', 'rotating', 'rotation', 'rotations'],
  ['prune', 'prunes', 'pruned', 'pruning', 'remove', 'removes', 'removed', 'removal'],
  ['old', 'older', 'oldest'],
  ['entry', 'entries'],
  ['fail', 'failed', 'failing', 'failure', 'failures'],
  ['expand', 'expanded', 'expands', 'expansion'],
  ['synonym', 'synonyms'],
  ['paraphrase', 'paraphrases'],
  ['own', 'owns', 'owned', 'owner', 'ownership'],
  ['restore', 'restored', 'restores', 'restoring'],
  ['deploy', 'deploys', 'deployed', 'deployment', 'deployments'],
  ['release', 'releases', 'released'],
  ['incident', 'incidents'],
  ['auth', 'authentication', 'authenticate', 'authenticated'],
  ['memory', 'memories'],
  ['retention', 'retain', 'retains', 'retained'],
  ['measure', 'measures', 'measured', 'measuring'],
  ['evaluate', 'evaluation', 'evaluates', 'evaluated'],
  ['embed', 'embedding', 'embeddings'],
  ['expire', 'expired', 'expires', 'expiration', 'expiring'],
  ['retry', 'retries', 'retried', 'retrying'],
  ['reject', 'rejects', 'rejected', 'rejection', 'invalid'],
  ['queue', 'queued', 'queues'],
  ['delay', 'delays', 'delayed', 'latency', 'latencies'],
  ['missing', 'absent'],
  ['reply', 'replies', 'replied', 'replying'],
  ['deliver', 'delivers', 'delivered', 'delivery'],
  ['configure', 'configures', 'configured', 'configuration'],
  ['allow', 'allows', 'allowed', 'allowlist'],
  ['deny', 'denies', 'denied'],
  ['install', 'installs', 'installed', 'installation'],
  ['origin', 'originating', 'originates', 'original'],
  ['approve', 'approves', 'approved', 'approval', 'approvals'],
  ['permanent', 'permanently'],
  ['transient', 'transiently'],
  ['performance', 'perf'],
  ['group', 'groups'],
  ['error', 'errors'],
  ['message', 'messages'],
  ['command', 'commands'],
  ['row', 'rows'],
]

const CANONICAL = new Map<string, string>()
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0]!
  for (const word of group) CANONICAL.set(word, canonical)
}

/** Query-only stop words. Body tokens are kept so phrase statistics stay intact. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by',
  'did', 'do', 'does', 'for', 'from', 'how', 'if', 'in', 'into', 'is', 'it',
  'its', 'no', 'nor', 'not', 'of', 'on', 'or', 'over', 'so', 'such', 'than',
  'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was',
  'were', 'what', 'when', 'where', 'which', 'who', 'whose', 'why', 'will',
  'with', 'without',
])

/** NFKC, lower-case, and collapse punctuation/whitespace into single spaces. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

export function canonicalTokens(text: string): string[] {
  return tokenize(text).map(token => CANONICAL.get(token) ?? token)
}

export function queryTokens(text: string): string[] {
  return [...new Set(canonicalTokens(text).filter(token => !STOPWORDS.has(token)))]
}

export function canonicalTokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of canonicalTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}
