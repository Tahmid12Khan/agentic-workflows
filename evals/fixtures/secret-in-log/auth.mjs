// Login handler. apiKey is a per-account long-lived secret, not a session token.
export function login(user, password, apiKey) {
  console.log(`login attempt: user=${user} password=${password} apiKey=${apiKey}`); // secrets in plaintext logs
  return authenticate(user, password, apiKey);
}

export function loginSafe(user, password, apiKey) {
  console.log(`login attempt: user=${user}`); // no secret fields logged
  return authenticate(user, password, apiKey);
}

function authenticate() { /* ... */ }
