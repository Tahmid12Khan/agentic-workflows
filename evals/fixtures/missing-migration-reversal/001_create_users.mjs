// Migration 001: create the users table. Fully reversible.
export async function up(db) {
  await db.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('email');
  });
}

export async function down(db) {
  await db.schema.dropTable('users');
}
