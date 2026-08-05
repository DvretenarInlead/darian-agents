/**
 * Bootstrap the first console admin. Without this there's no account to log in
 * with. Idempotent: upserts an `admin` role (all permissions) and the user,
 * (re)sets the password, and assigns the role.
 *
 *   CONSOLE_ADMIN_EMAIL=a@b.com CONSOLE_ADMIN_PASSWORD='…' pnpm tsx scripts/create-admin.ts
 *   # or: node dist/scripts/create-admin.js a@b.com 'password'
 *
 * Run as a DB role with DML on users/roles/user_roles (app_rw is sufficient).
 */
import { getPool, closePool } from '../src/core/db/index.js';
import { Argon2idHasher, checkPasswordStrength } from '../src/console/auth/password.js';

async function main(): Promise<void> {
  const email = process.argv[2] ?? process.env.CONSOLE_ADMIN_EMAIL;
  const password = process.argv[3] ?? process.env.CONSOLE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Usage: create-admin <email> <password>  (or CONSOLE_ADMIN_EMAIL / CONSOLE_ADMIN_PASSWORD)');
    process.exit(1);
  }
  const strength = checkPasswordStrength(password);
  if (!strength.ok) {
    console.error('Weak password:', strength.reasons.join('; '));
    process.exit(1);
  }

  const pool = getPool();
  try {
    const passwordHash = await new Argon2idHasher().hash(password);
    const role = await pool.query<{ id: string }>(
      `INSERT INTO roles (name, permissions) VALUES ('admin', '["*"]'::jsonb)
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions RETURNING id`,
    );
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active', updated_at = now()
       RETURNING id`,
      [email, passwordHash],
    );
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.rows[0]!.id, role.rows[0]!.id]);
    console.log(`Admin ready: ${email} (role: admin). Sign in at /console.`);
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
