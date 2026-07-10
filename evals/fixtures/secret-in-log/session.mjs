// Session TTL helper — no credentials handled here.
export function isExpired(session, now = Date.now()) {
  return session.expiresAt <= now;
}
