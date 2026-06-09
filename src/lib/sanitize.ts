/**
 * Escapes the five characters that turn plain text into executable HTML.
 * Apply to any user-supplied string before storing it — defense-in-depth
 * on top of React's automatic output encoding.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
