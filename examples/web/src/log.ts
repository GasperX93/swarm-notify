/** Event log panel — timestamped entries with technical details. */

const logEl = () => document.getElementById('event-log')!

export function log(tag: string, tagClass: string, message: string): void {
  const entry = document.createElement('div')
  entry.className = 'log-entry'

  const time = new Date().toLocaleTimeString('en-US', { hour12: false })
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-tag ${tagClass}">[${tag}]</span> ${message}`

  const container = logEl()
  container.appendChild(entry)
  container.scrollTop = container.scrollHeight
}

export function logAlice(message: string): void {
  log('Alice', 'alice', message)
}

export function logBob(message: string): void {
  log('Bob', 'bob', message)
}

export function logSystem(message: string): void {
  log('System', 'system', message)
}

export function clearLog(): void {
  logEl().innerHTML = ''
}

/** Truncate a hex string for display. */
export function short(hex: string, len = 8): string {
  if (hex.length <= len * 2 + 4) return hex
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return clean.slice(0, len) + '...' + clean.slice(-4)
}
