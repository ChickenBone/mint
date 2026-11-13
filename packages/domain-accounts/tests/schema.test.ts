import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AccountRole, AccountStatus } from "@mint/contracts";
import { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { accountsSchema, roleEnum, sessions, users, userStatusEnum } from "../src/schema";

const dialect = new PgDialect();
const userConfig = getTableConfig(users);
const sessionConfig = getTableConfig(sessions);
const initialSql = readFileSync(new URL("../../core/migrations/0000_init.sql", import.meta.url), "utf8");
const sourceSchema = readFileSync(new URL("../../core/src/db/schema.ts", import.meta.url), "utf8");

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
const roleContract: Equal<typeof users.$inferSelect.role, AccountRole> = true;
const statusContract: Equal<typeof users.$inferSelect.status, AccountStatus> = true;

const newUser = {
  email: "member@example.test",
  name: "Member",
  passwordHash: "$argon2id$opaque-stored-hash",
} satisfies typeof users.$inferInsert;
const newSession = {
  id: "a".repeat(64),
  userId: "12345678-1234-4234-8234-123456789012",
  expiresAt: new Date("2030-01-02T03:04:05.000Z"),
} satisfies typeof sessions.$inferInsert;
const storedUser: typeof users.$inferSelect = {
  ...newUser,
  id: newSession.userId,
  role: "user",
  status: "pending",
  requestNote: null,
  approvedAt: null,
  approvedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const storedSession: typeof sessions.$inferSelect = {
  ...newSession,
  userAgent: null,
  ip: null,
  createdAt: new Date(),
};

// Required insert fields and enum restrictions must remain enforced by inference.
// @ts-expect-error A stored password hash is required.
const missingPassword: typeof users.$inferInsert = { email: "member@example.test", name: "Member" };
// @ts-expect-error Sessions require expiry.
const missingExpiry: typeof sessions.$inferInsert = { id: "hash", userId: newSession.userId };
// @ts-expect-error Roles cannot expand beyond the public contract.
const invalidRole: typeof users.$inferInsert = { ...newUser, role: "operator" };
void [missingPassword, missingExpiry, invalidRole];

test("owns only users, sessions and their enums in the accounts namespace", () => {
  assert.equal(accountsSchema.schemaName, "accounts");
  assert.deepEqual([userConfig.name, sessionConfig.name], ["users", "sessions"]);
  for (const config of [userConfig, sessionConfig]) {
    assert.equal(config.schema, "accounts");
    assert.deepEqual(config.checks, []);
    assert.deepEqual(config.uniqueConstraints, []);
    assert.deepEqual(config.primaryKeys, []);
    assert.deepEqual(config.policies, []);
    assert.equal(config.enableRLS, false);
  }
  assert.equal(roleEnum.schema, "accounts");
  assert.equal(userStatusEnum.schema, "accounts");
  assert.equal(roleEnum.enumName, "role");
  assert.equal(userStatusEnum.enumName, "user_status");
  assert.deepEqual(roleEnum.enumValues, ["user", "admin"]);
  assert.deepEqual(userStatusEnum.enumValues, ["pending", "active", "denied", "disabled"]);
  assert.ok(roleContract && statusContract);
});

test("preserves every initial SQL column type, nullability, primary key and default", () => {
  for (const config of [userConfig, sessionConfig]) {
    const body = initialSql.match(new RegExp(`CREATE TABLE "${config.name}" \\(\\n([\\s\\S]*?)\\n\\);`))?.[1];
    assert.ok(body, `missing source table ${config.name}`);
    const sourceColumns = body.split(",\n").map((line) => {
      const match = line.trim().match(/^"([^"]+)" (.+)$/);
      assert.ok(match, `unrecognized source column ${line}`);
      assert.ok(match[1] && match[2], `incomplete source column ${line}`);
      return { name: match[1], definition: match[2] };
    });
    assert.deepEqual(config.columns.map((column) => column.name), sourceColumns.map((column) => column.name));
    for (const [position, column] of config.columns.entries()) {
      const sourceColumn = sourceColumns[position];
      assert.ok(sourceColumn, `missing source column at position ${position}`);
      const definition = sourceColumn.definition;
      const sqlType = column.getSQLType();
      const sourceType = sqlType === "role" || sqlType === "user_status" ? `"${sqlType}"` : sqlType;
      assert.ok(definition.startsWith(`${sourceType} `) || definition === sourceType, column.name);
      assert.equal(column.notNull, definition.includes("NOT NULL"), column.name);
      assert.equal(column.primary, definition.includes("PRIMARY KEY"), column.name);
      const sourceDefault = definition.match(/ DEFAULT (.+?)(?: NOT NULL|$)/)?.[1];
      assert.equal(column.hasDefault, sourceDefault !== undefined, column.name);
      const actualDefault = column.default instanceof SQL
        ? dialect.sqlToQuery(column.default).sql
        : column.default === undefined ? undefined : `'${column.default}'`;
      assert.equal(actualDefault, sourceDefault, column.name);
    }
  }
});

test("keeps enum values equivalent to the initial SQL without importing legacy runtime", () => {
  for (const enumeration of [roleEnum, userStatusEnum]) {
    const values = enumeration.enumValues.map((value) => `'${value}'`).join(", ");
    assert.ok(initialSql.includes(`CREATE TYPE "public"."${enumeration.enumName}" AS ENUM(${values});`));
  }
});

test("retains the lower(email) unique index and ordinary session user index", () => {
  assert.equal(userConfig.indexes.length, 1);
  const firstUserIndex = userConfig.indexes[0];
  assert.ok(firstUserIndex);
  const emailIndex = firstUserIndex.config;
  assert.equal(emailIndex.name, "users_email_idx");
  assert.equal(emailIndex.unique, true);
  assert.equal(emailIndex.method, "btree");
  assert.equal(emailIndex.columns.length, 1);
  const expression = emailIndex.columns[0];
  assert.ok(expression instanceof SQL);
  assert.equal(dialect.sqlToQuery(expression).sql, 'lower("accounts"."users"."email")');
  assert.ok(initialSql.includes('CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email"));'));

  assert.equal(sessionConfig.indexes.length, 1);
  const firstSessionIndex = sessionConfig.indexes[0];
  assert.ok(firstSessionIndex);
  const userIndex = firstSessionIndex.config;
  assert.equal(userIndex.name, "sessions_user_idx");
  assert.equal(userIndex.unique, false);
  assert.equal(userIndex.method, "btree");
  assert.equal(userIndex.columns.length, 1);
  const indexedColumn = userIndex.columns[0];
  assert.ok(indexedColumn);
  assert.ok("name" in indexedColumn);
  assert.equal(indexedColumn.name, "user_id");
  assert.ok(initialSql.includes('CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");'));
});

test("cascades sessions only to the target user table and does not invent an approver FK", () => {
  assert.equal(userConfig.foreignKeys.length, 0);
  assert.equal(sessionConfig.foreignKeys.length, 1);
  const foreignKey = sessionConfig.foreignKeys[0];
  assert.ok(foreignKey);
  const reference = foreignKey.reference();
  assert.equal(foreignKey.getName(), "sessions_user_id_users_id_fk");
  assert.equal(foreignKey.onDelete, "cascade");
  assert.equal(foreignKey.onUpdate, "no action");
  assert.deepEqual(reference.columns, [sessions.userId]);
  assert.equal(reference.foreignTable, users);
  assert.deepEqual(reference.foreignColumns, [users.id]);
  assert.ok(initialSql.includes('CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action'));
  assert.ok(!initialSql.includes('FOREIGN KEY ("approved_by")'));
});

test("preserves timezone dates and the application-side updatedAt callback", () => {
  const dateColumns = [users.approvedAt, users.createdAt, users.updatedAt, sessions.expiresAt, sessions.createdAt];
  for (const column of dateColumns) {
    assert.equal(column.getSQLType(), "timestamp with time zone");
    assert.equal(column.dataType, "date");
  }
  assert.match(sourceSchema, /updatedAt: timestamp\("updated_at", \{ withTimezone: true \}\)[\s\S]*?\.\$onUpdate\(\(\) => new Date\(\)\)/);
  assert.ok(users.updatedAt.onUpdateFn);
  const before = Date.now();
  const updatedAt = users.updatedAt.onUpdateFn();
  assert.ok(updatedAt instanceof Date);
  assert.ok(updatedAt.getTime() >= before && updatedAt.getTime() <= Date.now());
  for (const column of [...userConfig.columns, ...sessionConfig.columns]) {
    if (column !== users.updatedAt) assert.equal(column.onUpdateFn, undefined, column.name);
  }
});

test("insert/select fixtures preserve opaque hashes and nullable session evidence", () => {
  assert.equal(users.passwordHash.getSQLType(), "text");
  assert.equal(sessions.id.getSQLType(), "text");
  assert.equal(storedUser.passwordHash, newUser.passwordHash);
  assert.equal(storedSession.id, newSession.id);
  assert.equal(storedSession.userAgent, null);
  assert.equal(storedSession.ip, null);
});
