// Signup handler that deliberately gets the patterns other fixtures get wrong: null-checked,
// parameterized, and scoped to the caller's own account.
export async function signup(req, res, db) {
  const email = req.body?.email;
  if (!email) return res.sendStatus(400);
  const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) return res.sendStatus(409);
  const user = await db.users.create({ email });
  res.json({ id: user.id });
}

export function updateOwnProfile(req, res, db) {
  if (req.user.id !== req.params.id) return res.sendStatus(403);
  db.users.update(req.params.id, { displayName: req.body?.displayName });
  res.sendStatus(204);
}
