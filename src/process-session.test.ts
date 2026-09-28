import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ProcessStartProfile } from "./process-profile.ts";
import { reserveProcessSession, verifyProcessSession } from "./process-session.ts";

test("process session reservation is exclusive and resume validates ownership and identity", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pasa-session-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "sessions");
  mkdirSync(dir, { mode: 0o700 });
  const profile = {
    cwd: root,
    identity: { sessionId: "planned-session" },
    session: { file: join(dir, "session.jsonl") },
  } as ProcessStartProfile;
  reserveProcessSession(profile);
  verifyProcessSession(profile);
  assert.throws(() => reserveProcessSession(profile), { code: "SESSION_COLLISION" });
  chmodSync(profile.session.file, 0o644);
  assert.throws(() => verifyProcessSession(profile), { code: "SESSION_OWNERSHIP_MISMATCH" });
  chmodSync(profile.session.file, 0o600);
  const header = JSON.parse(readFileSync(profile.session.file, "utf8"));
  header.id = "different-session";
  writeFileSync(profile.session.file, JSON.stringify(header) + "\n");
  assert.throws(() => verifyProcessSession(profile), { code: "SESSION_IDENTITY_MISMATCH" });
  const other = { ...profile, session: { ...profile.session, file: join(dir, "link.jsonl") } };
  symlinkSync(profile.session.file, other.session.file);
  assert.throws(() => verifyProcessSession(other), { code: "SESSION_UNAVAILABLE" });
});
