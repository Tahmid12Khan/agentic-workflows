// HTTP handler for account deletion, mounted at DELETE /accounts/:id.
export function deleteAccount(req, res, db) {
  const targetId = req.params.id;
  db.accounts.delete(targetId); // no check that req.user.id === targetId or req.user.isAdmin
  res.sendStatus(204);
}

export function getAccount(req, res, db) {
  if (req.user.id !== req.params.id && !req.user.isAdmin) return res.sendStatus(403);
  res.json(db.accounts.find(req.params.id));
}
