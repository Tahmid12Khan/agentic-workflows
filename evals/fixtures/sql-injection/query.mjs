// Looks a user up by display name for the admin search box.
export function findUserByName(db, name) {
  const sql = `SELECT * FROM users WHERE name = '${name}'`; // untrusted input spliced into SQL text
  return db.query(sql);
}

export function findUserById(db, id) {
  return db.query('SELECT * FROM users WHERE id = ?', [id]); // parameterized — safe
}
