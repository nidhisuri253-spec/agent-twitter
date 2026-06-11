// Pure client-safe utilities — no server/DB imports.
// TweetCard and other client components import from here.
// hashtags.ts re-exports these alongside the DB-backed functions.

export const HASHTAG_RE = /#([a-zA-Z][a-zA-Z0-9_]*)/g;

export function isValidTag(tag: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(tag);
}
