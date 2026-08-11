import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error("Usage: tsx scripts/create-empty-test-db.ts <source-db> <target-db>");
const source = resolve(sourceArg);
const target = resolve(targetArg);
const workspace = resolve(process.cwd());
if (!target.startsWith(`${workspace}\\`) && !target.startsWith(`${workspace}/`)) throw new Error(`Refusing target outside workspace: ${target}`);
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target);
copyFileSync(source, target);
const db = new Database(target);
try {
  const keep = new Set(["effect_sql_migrations", "sqlite_sequence"]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  db.transaction(() => {
    for (const { name } of tables) {
      if (!keep.has(name)) db.prepare(`DELETE FROM "${name}"`).run();
    }
    db.prepare("DELETE FROM sqlite_sequence").run();
  })();
  console.log(JSON.stringify({ target, migration: (db.prepare("SELECT MAX(migration_id) migration FROM effect_sql_migrations").get() as { migration: number }).migration }));
} finally { db.close(); }
