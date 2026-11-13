# Register an existing target Library root

This private operator command registers one existing directory in the **fresh
target database**. Run it as the same unprivileged Linux user and with the same
read-only media mount/path as the scanner. Apply the target migrations through
the normal startup procedure first; this command neither migrates nor starts
the API, scanner or jobs.

From the repository root, provide these explicit environment variables through
your operator environment/secret mechanism (do not put passwords in arguments):

| Variable | Value |
| --- | --- |
| `MINT_LIBRARY_ROOT_PATH` | Canonical absolute directory, for example `/media/music` |
| `MINT_API_DB_HOST` | Private PostgreSQL hostname or absolute Unix socket directory |
| `MINT_API_DB_PORT` | PostgreSQL port, for example `5432` |
| `MINT_API_DB_NAME` | Target database name |
| `MINT_API_DB_USER` | Operator database role with Library read/insert/table-lock privileges |
| `MINT_API_DB_PASSWORD` | Explicit password; empty is allowed for local socket authentication |
| `MINT_API_DB_TLS` | `verify` or explicitly `disabled` on a trusted private connection |
| `MINT_API_DB_CONNECT_TIMEOUT_MS` | Positive connection timeout in milliseconds |

```sh
corepack pnpm --filter @mint/api exec tsx src/provision-library-root.ts
```

No arguments are accepted. Success writes one JSON record to stdout:
`{"event":"library-root-provisioned","rootId":"<uuid>","created":true}`.
Repeat invocations return the existing UUID with `created:false`. Use that UUID
in the scanner's explicit root configuration; registration alone imports no
files and grants no playback access.

Paths must already be canonical, without symlink components, trailing slash,
`.`/`..`, repeated separators, backslashes or control characters. `/` is rejected.
The directory is opened read-only and its identity and `/proc/self/fd` path are
checked before registration and again before commit. No directory entries or
audio are read, and no files, tags, existing roots or media rows are modified.
Mount the originals read-only separately: this command does not change or prove
the mount's write protection.

Concurrent invocations serialize with a transaction-scoped Library roots table
lock (five-second lock wait, ten-second statement timeout). Existing duplicate
rows for the exact path fail as `AMBIGUOUS_ROOT`; nothing is chosen, deleted or
reset. Other privileged writers can still insert duplicates after this command,
and paths are not durable device/inode bindings. Provisioning is not an atomic
filesystem/database snapshot; later scans must revalidate confinement, mount
availability and media.

Failures exit nonzero and report only a phase and safe error code on stderr
(and a configuration field name when applicable), never database credentials,
raw SQL, paths or driver messages. Check local configuration, mount access and
database availability/permissions, then retry. A lost connection or stdout
failure after commit can leave a registered root without a received result;
retrying safely recovers its UUID. Filesystem operations are not hard-timed.

Focused disposable tests (never use a deployment database):

```sh
MINT_TEST_POSTGRES_BIN=/usr/lib/postgresql/16/bin \
  corepack pnpm --filter @mint/api exec tsx --test tests/provision-library-root.integration.test.ts
```
