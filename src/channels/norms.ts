/** IM keeps replies short. GitHub gets a small structured note. */
export function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return text.trim()
  return `${words.slice(0, maxWords).join(' ')}…`
}

export function renderOutbound(channel: string, text: string, ticketId: string): string {
  if (channel === 'im') return truncateWords(text, 100)
  if (channel === 'github') {
    return [`ds-agent note`, `ticket: ${ticketId}`, '', truncateWords(text, 80)].join('\n')
  }
  return truncateWords(text, 200)
}
