import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, AUTH_MIGRATIONS } from "./d1.js";
import {
  parseUsers, sessionLimits, startLogin, verifyCode, resendNtfyCode, getSession, endSession, challengeStage, NTFY_RESENDS,
  MAX_ATTEMPTS, CODE_TTL_S, NTFY_TTL_S, SESSION_IDLE_S, SESSION_TTL_S, SEND_LIMIT, SEND_WINDOW_S,
  SEND_DAILY_LIMIT, FAIL_DAILY_LIMIT, DAY_S,
} from "../src/auth.js";

const USERS = JSON.stringify([{ email: "Staff@Example.org", ntfyTopic: "secret-topic-123" }]);
const setup = () => ({ db: fakeD1(AUTH_MIGRATIONS), users: parseUsers(USERS).users });
const T = 1_800_000_000;

/** Right code for whatever stage `c` is at, or a guaranteed wrong one. */
const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

async function signIn({ db, users }, now = T) {
  const s = await startLogin({ db, users, email: " staff@example.ORG ", now });
  const e = await verifyCode({ db, users, challengeId: s.challengeId, code: s.deliver.code, now });
  const n = await verifyCode({ db, users, challengeId: s.challengeId, code: e.ntfy.code, now });
  return n.session;
}

test("parseUsers fails closed on anything malformed", () => {
  assert.equal(parseUsers("").users.size, 0);
  assert.equal(parseUsers("{").users.size, 0);
  assert.equal(parseUsers('[{"email":"a@b.c"}]').users.size, 1, "a topic is optional");
  assert.equal(parseUsers('[{"email":"a@b.c","ntfyTopic":"x/y"}]').users.size, 0);
  assert.equal(parseUsers('[{"email":"a@b.c","ntfyTopic":"ok"},{"email":"nope","ntfyTopic":"ok"}]').users.size, 0);
  assert.deepEqual([...parseUsers(USERS).users.keys()], ["staff@example.org"]);
});

test("full flow: email code, then ntfy code, then a session", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "staff@example.org", now: T });
  assert.match(s.deliver.code, /^\d{6}$/);
  assert.equal(await challengeStage({ db: env.db, challengeId: s.challengeId, now: T }), "email");

  const e = await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T });
  assert.equal(e.ok, true);
  assert.equal(e.ntfy.topic, "secret-topic-123");
  assert.equal(await challengeStage({ db: env.db, challengeId: s.challengeId, now: T }), "ntfy");

  const n = await verifyCode({ ...env, challengeId: s.challengeId, code: e.ntfy.code.replace(/^(\d{3})/, "$1 "), now: T });
  assert.equal(n.ok, true);
  assert.equal(n.session.email, "staff@example.org");
  assert.equal(await challengeStage({ db: env.db, challengeId: s.challengeId, now: T }), null, "challenge is used up");
  assert.deepEqual(await getSession({ ...env, token: n.session.token, now: T }), { email: "staff@example.org" });

  const stored = env.db.sqlite.prepare("SELECT id_hash FROM sessions").get();
  assert.notEqual(stored.id_hash, n.session.token, "only the hash is stored");
});

test("an address not on the list gets a challenge but no code, and can never verify", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "someone@else.org", now: T });
  assert.equal(s.deliver, null);
  assert.match(s.challengeId, /^[0-9a-f]{32}$/);
  assert.equal(await challengeStage({ db: env.db, challengeId: s.challengeId, now: T }), "email");
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const r = await verifyCode({ ...env, challengeId: s.challengeId, code: "000000", now: T });
    assert.deepEqual(r, { ok: false, reason: "wrong-code", attemptsLeft: MAX_ATTEMPTS - i });
  }
  assert.equal((await verifyCode({ ...env, challengeId: s.challengeId, code: "000000", now: T })).reason, "burned");
});

test("wrong codes burn the challenge after MAX_ATTEMPTS, even for the right code after", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "staff@example.org", now: T });
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    assert.equal((await verifyCode({ ...env, challengeId: s.challengeId, code: wrong(s.deliver.code), now: T })).reason, "wrong-code");
  }
  assert.equal((await verifyCode({ ...env, challengeId: s.challengeId, code: wrong(s.deliver.code), now: T })).reason, "burned");
  assert.equal((await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T })).reason, "no-challenge");
});

test("codes expire, and the ntfy stage has its own shorter clock", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "staff@example.org", now: T });
  assert.equal((await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T + CODE_TTL_S + 1 })).reason, "no-challenge");

  const s2 = await startLogin({ ...env, email: "staff@example.org", now: T });
  const e = await verifyCode({ ...env, challengeId: s2.challengeId, code: s2.deliver.code, now: T });
  assert.equal((await verifyCode({ ...env, challengeId: s2.challengeId, code: e.ntfy.code, now: T + NTFY_TTL_S + 1 })).reason, "no-challenge");
});

test("the email code does not work at the ntfy stage", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "staff@example.org", now: T });
  const e = await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T });
  const r = await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T });
  if (s.deliver.code !== e.ntfy.code) assert.equal(r.reason, "wrong-code");
});

test("codes are sent at most SEND_LIMIT times per window per address", async () => {
  const env = setup();
  const sent = [];
  for (let i = 0; i < SEND_LIMIT + 2; i++) sent.push((await startLogin({ ...env, email: "staff@example.org", now: T })).deliver);
  assert.equal(sent.filter(Boolean).length, SEND_LIMIT);
  assert.ok((await startLogin({ ...env, email: "staff@example.org", now: T + SEND_WINDOW_S })).deliver, "new window");
});

test("sessionLimits: env overrides, defaults for missing or bad values", () => {
  assert.deepEqual(sessionLimits({}), { ttl: SESSION_TTL_S, idle: SESSION_IDLE_S });
  assert.deepEqual(sessionLimits({ ADMIN_SESSION_TTL_S: "7200", ADMIN_SESSION_IDLE_S: 600 }), { ttl: 7200, idle: 600 });
  for (const bad of ["", "0", "-5", "1.5", "1h", null]) {
    assert.deepEqual(sessionLimits({ ADMIN_SESSION_TTL_S: bad, ADMIN_SESSION_IDLE_S: bad }), { ttl: SESSION_TTL_S, idle: SESSION_IDLE_S }, String(bad));
  }
});

test("sessions: overridden limits set the cookie and the checks", async () => {
  const env = setup();
  const limits = { ttl: 1000, idle: 100 };
  const signInWith = async () => {
    const s = await startLogin({ ...env, email: "staff@example.org", now: T });
    const e = await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T });
    return (await verifyCode({ ...env, challengeId: s.challengeId, code: e.ntfy.code, limits, now: T })).session;
  };
  const session = await signInWith();
  assert.equal(session.maxAge, 1000);
  const token = session.token;
  assert.ok(await getSession({ ...env, token, limits, now: T + 99 }));
  assert.equal(await getSession({ ...env, token, limits, now: T + 99 + 101 }), null, "idle");
  const token2 = (await signInWith()).token;
  for (let t = T; t <= T + 1000; t += 90) assert.ok(await getSession({ ...env, token: token2, limits, now: t }));
  assert.equal(await getSession({ ...env, token: token2, limits, now: T + 1001 }), null, "absolute");
});

test("sessions: idle timeout, absolute timeout, logout, removal from the list", async () => {
  let env = setup();
  let token = (await signIn(env)).token;
  assert.ok(await getSession({ ...env, token, now: T + SESSION_IDLE_S - 1 }), "touch");
  assert.ok(await getSession({ ...env, token, now: T + 2 * SESSION_IDLE_S - 2 }), "idle measured from the touch");
  assert.equal(await getSession({ ...env, token, now: T + 4 * SESSION_IDLE_S }), null, "idle");

  env = setup();
  token = (await signIn(env)).token;
  let t = T;
  for (; t < T + SESSION_TTL_S; t += SESSION_IDLE_S / 2) assert.ok(await getSession({ ...env, token, now: t }));
  assert.equal(await getSession({ ...env, token, now: T + SESSION_TTL_S + 1 }), null, "absolute");

  env = setup();
  token = (await signIn(env)).token;
  await endSession({ db: env.db, token });
  assert.equal(await getSession({ ...env, token, now: T }), null, "logout");

  env = setup();
  token = (await signIn(env)).token;
  assert.equal(await getSession({ db: env.db, users: new Map(), token, now: T }), null, "removed from the list");
  assert.equal(await getSession({ ...env, token: "not-a-token", now: T }), null);
});

test("resendNtfyCode: ntfy stage only, replaces the code, keeps attempts, is limited", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "staff@example.org", now: T });
  assert.equal((await resendNtfyCode({ ...env, challengeId: s.challengeId, now: T })).reason, "no-challenge", "not at the email stage");
  const e = await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, now: T });
  await verifyCode({ ...env, challengeId: s.challengeId, code: wrong(e.ntfy.code), now: T });

  const r = await resendNtfyCode({ ...env, challengeId: s.challengeId, now: T });
  assert.equal(r.ok, true);
  assert.equal(r.ntfy.topic, "secret-topic-123");
  if (r.ntfy.code !== e.ntfy.code) {
    assert.equal((await verifyCode({ ...env, challengeId: s.challengeId, code: e.ntfy.code, now: T })).reason, "wrong-code", "old code dead");
  }
  const attempts = env.db.sqlite.prepare("SELECT attempts FROM challenges").get().attempts;
  assert.ok(attempts >= 1, "attempts not reset");

  for (let i = 1; i < NTFY_RESENDS; i++) assert.equal((await resendNtfyCode({ ...env, challengeId: s.challengeId, now: T })).ok, true);
  assert.equal((await resendNtfyCode({ ...env, challengeId: s.challengeId, now: T })).reason, "limit");
  const last = await resendNtfyCode({ db: env.db, users: new Map(), challengeId: s.challengeId, now: T });
  assert.equal(last.reason, "no-challenge", "removed from the list");
});

test("second factor OFF: the emailed code alone gives a session", async () => {
  const env = setup();
  const s = await startLogin({ ...env, email: "staff@example.org", now: T });
  const r = await verifyCode({ ...env, challengeId: s.challengeId, code: s.deliver.code, secondFactor: false, now: T });
  assert.equal(r.ok, true);
  assert.equal(r.ntfy, undefined, "no phone code made");
  assert.deepEqual(await getSession({ ...env, token: r.session.token, now: T }), { email: "staff@example.org" });
  assert.equal(await challengeStage({ db: env.db, challengeId: s.challengeId, now: T }), null);
});

test("second factor ON: a user with no topic cannot get past the email step", async () => {
  const db = fakeD1(AUTH_MIGRATIONS);
  const users = parseUsers('[{"email":"notopic@example.org"}]').users;
  const s = await startLogin({ db, users, email: "notopic@example.org", now: T });
  const r = await verifyCode({ db, users, challengeId: s.challengeId, code: s.deliver.code, now: T });
  assert.deepEqual(r, { ok: false, reason: "burned" });
});

test("the same rate-limit work for every address, keyed by hash: the table never holds an address", async () => {
  const env = setup();
  await startLogin({ ...env, email: "staff@example.org", now: T });
  await startLogin({ ...env, email: "Stranger@Example.org", now: T });
  const keys = env.db.sqlite.prepare("SELECT key FROM rate ORDER BY key").all().map((r) => r.key);
  assert.equal(keys.length, 4, "send + sendday for BOTH addresses, listed or not");
  for (const k of keys) {
    assert.match(k, /^(send|sendday):[0-9a-f]{64}$/);
    assert.doesNotMatch(k, /@/);
  }
});

test("at most SEND_DAILY_LIMIT codes a day per address, and old rate rows are cleared", async () => {
  const env = setup();
  let sent = 0;
  for (let i = 0; i < SEND_DAILY_LIMIT + 5; i++) {
    // a new 15-minute window each time, so only the daily limit can bite
    const s = await startLogin({ ...env, email: "staff@example.org", now: T + i * (SEND_WINDOW_S + 1) });
    if (s.deliver) sent++;
  }
  assert.equal(sent, SEND_DAILY_LIMIT);
  const s = await startLogin({ ...env, email: "staff@example.org", now: T + DAY_S + 1 });
  assert.ok(s.deliver, "a new day, a new code");
  const oldest = env.db.sqlite.prepare("SELECT MIN(window_start) AS m FROM rate").get().m;
  assert.ok(oldest >= T + 1, "rows from more than a day ago are gone");
});

test("FAIL_DAILY_LIMIT wrong codes lock the address for the day - even the right code after", async () => {
  const env = setup();
  let fails = 0;
  let t = T;
  while (fails < FAIL_DAILY_LIMIT) {
    t += SEND_WINDOW_S + 1;
    const s = await startLogin({ ...env, email: "someone@else.org", now: t });   // no code, any address
    for (let i = 0; i < MAX_ATTEMPTS - 1 && fails < FAIL_DAILY_LIMIT; i++, fails++) {
      await verifyCode({ ...env, challengeId: s.challengeId, code: "000000", now: t });
    }
  }
  // someone@else.org is not listed: the lock is per address, so staff is unaffected
  const ok = await startLogin({ ...env, email: "staff@example.org", now: t });
  assert.equal((await verifyCode({ ...env, challengeId: ok.challengeId, code: ok.deliver.code, now: t })).ok, true);

  const env2 = setup();
  t = T;
  for (let n = 0; n < FAIL_DAILY_LIMIT;) {
    t += SEND_WINDOW_S + 1;
    const s = await startLogin({ ...env2, email: "staff@example.org", now: t });
    for (let i = 0; i < MAX_ATTEMPTS - 1 && n < FAIL_DAILY_LIMIT; i++, n++) {
      await verifyCode({ ...env2, challengeId: s.challengeId, code: wrong(s.deliver?.code ?? "000000"), now: t });
    }
  }
  const late = await startLogin({ ...env2, email: "staff@example.org", now: t + 1 });
  const r = await verifyCode({ ...env2, challengeId: late.challengeId, code: late.deliver?.code ?? "000000", now: t + 1 });
  assert.deepEqual(r, { ok: false, reason: "burned" }, "the right code is refused once the budget is spent");
  const next = await startLogin({ ...env2, email: "staff@example.org", now: t + DAY_S + 1 });
  assert.equal((await verifyCode({ ...env2, challengeId: next.challengeId, code: next.deliver.code, now: t + DAY_S + 1 })).ok, true,
    "and works again a day later");
});
