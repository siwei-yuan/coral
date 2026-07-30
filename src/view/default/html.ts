export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value
}

export function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
