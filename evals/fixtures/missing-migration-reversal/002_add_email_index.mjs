// Migration 002: back-fill and index users.email. Runner calls up() to apply, down() to revert.
export async function up(db) {
  await db.schema.alterTable('users', (t) => {
    t.string('email').notNullable();
    t.index('email');
  });
} // no down() exported — this migration cannot be rolled back once applied
