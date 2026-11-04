import type { SnapshotEvent, SnapshotOutbox, SnapshotThread, SnapshotTicket, UiSnapshot } from './server.ts'

const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #0f172a;
  --panel: #16213a;
  --line: #2b3a55;
  --text: #e6edf7;
  --muted: #94a3b8;
  --accent: #7dd3fc;
  --ok: #86efac;
  --warn: #fde68a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0; letter-spacing: 0.01em; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; }
.sub { color: var(--muted); }
.live { color: var(--ok); font-variant-numeric: tabular-nums; }
main { display: grid; gap: 18px; max-width: 1180px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.empty { color: var(--muted); font-style: italic; }
.count { color: var(--muted); font-weight: 400; margin-left: 6px; }
.wrap { overflow-wrap: anywhere; }
`

/** Escape untrusted text before it reaches the HTML page. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, char => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return char
    }
  })
}

function table(headers: readonly string[], rows: readonly (readonly string[])[], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`
  const head = headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')
  const body = rows
    .map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function code(value: unknown): string {
  return `<code>${escapeHtml(value)}</code>`
}

function ticketRows(tickets: readonly SnapshotTicket[]): string[][] {
  return tickets.map(ticket => [
    code(ticket.id),
    `<span class="wrap">${escapeHtml(ticket.title)}</span>`,
    code(ticket.stage),
    ticket.ended ? 'yes' : 'no',
    ticket.paused ? 'yes' : 'no',
    code(ticket.createdAt),
  ])
}

function threadRows(threads: readonly SnapshotThread[]): string[][] {
  return threads.map(thread => [
    code(thread.key),
    thread.subscriptions.length === 0 ? '<span class="empty">none</span>' : thread.subscriptions.map(code).join(', '),
    String(thread.pending),
    thread.deferred ? 'yes' : 'no',
    thread.lastAt ? code(thread.lastAt) : '<span class="empty">-</span>',
  ])
}

function outboxRows(outbox: readonly SnapshotOutbox[]): string[][] {
  return outbox.map(row => [
    code(row.id),
    code(row.status),
    code(row.channel),
    code(row.thread),
    code(row.ticketId),
    String(row.attempts),
    code(row.createdAt),
  ])
}

function eventRows(events: readonly SnapshotEvent[]): string[][] {
  return events.map(event => [
    code(event.kind),
    `<span class="wrap">${escapeHtml(JSON.stringify(event.payload) ?? '')}</span>`,
  ])
}

/** Server-rendered read-only page. All dynamic text is escaped. */
export function renderHtml(snapshot: UiSnapshot): string {
  const counters = Object.entries(snapshot.metrics.counters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [code(name), String(value)])
  const latency = snapshot.metrics.modelLatencyMs
  const healthRows = [
    [code('store'), escapeHtml(snapshot.health.store)],
    [code('vault'), escapeHtml(snapshot.health.vaultMode)],
    [code('machines online'), String(snapshot.health.machinesOnline)],
    [code('watchdog idle'), snapshot.health.watchdogIdle ? 'yes' : 'no'],
  ]

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ds-agent local ui</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>
  <h1>ds-agent local ui</h1>
  <span class="sub">generated ${code(snapshot.generatedAt)}</span>
  <span class="sub">stream <span class="live" id="live">connecting</span></span>
</header>
<main>
<section>
  <h2>Health</h2>
  ${table(['check', 'value'], healthRows, 'no health data')}
</section>
<section>
  <h2>Metrics<span class="count">${counters.length} counters</span></h2>
  ${table(['counter', 'value'], counters, 'no counters')}
  <p class="sub">model latency: count ${escapeHtml(latency.count)} · sum ${escapeHtml(latency.sum)} ms · max ${escapeHtml(latency.max)} ms · last ${escapeHtml(latency.last)} ms</p>
</section>
<section>
  <h2>Tickets<span class="count">${snapshot.tickets.length}</span></h2>
  ${table(['id', 'title', 'stage', 'ended', 'paused', 'created'], ticketRows(snapshot.tickets), 'no tickets')}
</section>
<section>
  <h2>Threads<span class="count">${snapshot.threads.length}</span></h2>
  ${table(['thread', 'subscriptions', 'pending', 'deferred', 'last'], threadRows(snapshot.threads), 'no threads')}
</section>
<section>
  <h2>Outbox<span class="count">${snapshot.outbox.length}</span></h2>
  ${table(['id', 'status', 'channel', 'thread', 'ticket', 'attempts', 'created'], outboxRows(snapshot.outbox), 'no outbox rows')}
</section>
<section>
  <h2>Lifecycle events<span class="count">${snapshot.events.length}</span></h2>
  ${table(['kind', 'payload'], eventRows(snapshot.events), 'no lifecycle events')}
</section>
</main>
<script>
(() => {
  const status = document.getElementById('live');
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => { if (status) status.textContent = 'live'; });
  source.addEventListener('error', () => { if (status) status.textContent = 'reconnecting'; });
})();
</script>
</body>
</html>
`
}
