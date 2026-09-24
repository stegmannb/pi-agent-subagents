import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { test } from "node:test";
import { Broker, writeFrame } from "./broker.mjs";

async function setup(t) {
  const broker = new Broker(
    join(mkdtempSync(join(tmpdir(), "pi-mail-test-")), "mail.sock"),
    "test-token",
  );
  await broker.start();
  t.after(() => broker.close());
  async function peer(name, token = "test-token") {
    const socket = connect(broker.path);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    writeFrame(socket, { type: "hello", peer: name, token });
    if (token === "test-token")
      await broker.waitFor((event) => event.type === "registered" && event.peer === name);
    return socket;
  }
  return { broker, peer };
}

test("routes both directions, binds sender, and correlates replies", async (t) => {
  const { broker, peer } = await setup(t);
  const a = await peer("a");
  const b = await peer("b");
  writeFrame(a, {
    type: "send",
    kind: "question",
    from: "forged",
    id: "q",
    to: "b",
    text: "Question",
  });
  const routed = await broker.waitFor((event) => event.type === "routed");
  assert.equal(routed.envelope.from, "a");
  writeFrame(b, { type: "send", kind: "reply", id: "r", to: "a", replyTo: "q", text: "Answer" });
  const reply = await broker.waitFor((event) => event.envelope?.id === "r");
  assert.equal(reply.envelope.replyTo, "q");
  assert.equal(broker.questions.size, 0);
});

test("rejects a wrong run token", async (t) => {
  const { broker, peer } = await setup(t);
  await peer("a", "wrong");
  await broker.waitFor((event) => event.type === "rejected");
  assert.equal(broker.peers.size, 0);
});

test("rejects unmatched replies and duplicate message IDs", async (t) => {
  const { broker, peer } = await setup(t);
  const a = await peer("a");
  const b = await peer("b");
  writeFrame(b, {
    type: "send",
    kind: "reply",
    id: "r",
    to: "a",
    replyTo: "missing",
    text: "Wrong",
  });
  await broker.waitFor((event) => event.reason === "reply does not match an open question");
  const question = { type: "send", kind: "question", id: "q", to: "b", text: "Question" };
  writeFrame(a, question);
  await broker.waitFor((event) => event.type === "routed");
  writeFrame(a, question);
  await broker.waitFor((event) => event.reason?.includes("duplicate ID"));
  assert.equal(broker.events.filter((event) => event.type === "routed").length, 1);
});

test("reports disconnected recipients and times out without an answer", async (t) => {
  const { broker, peer } = await setup(t);
  const a = await peer("a");
  const b = await peer("b");
  b.destroy();
  await broker.waitFor((event) => event.type === "disconnected" && event.peer === "b");
  writeFrame(a, { type: "send", kind: "question", id: "q", to: "b", text: "Question" });
  await broker.waitFor((event) => event.type === "rejected");
  await assert.rejects(
    broker.waitFor((event) => event.type === "routed", 20),
    /Timed out/,
  );
});

test("accepts fragmented JSON lines and coalesced frames", async (t) => {
  const { broker, peer } = await setup(t);
  const a = await peer("a");
  await peer("b");
  const frame = JSON.stringify({
    type: "send",
    kind: "question",
    id: "q",
    to: "b",
    text: "Question",
  });
  a.write(frame.slice(0, 9));
  a.write(`${frame.slice(9)}\n${JSON.stringify({ type: "event", name: "after-send" })}\n`);
  await broker.waitFor((event) => event.name === "after-send");
  assert.equal(broker.events.filter((event) => event.type === "routed").length, 1);
});

test("disconnects malformed and oversized input without crashing the broker", async (t) => {
  const { broker, peer } = await setup(t);
  const a = await peer("a");
  const b = await peer("b");
  a.write("not json\n");
  await broker.waitFor((event) => event.type === "disconnected" && event.peer === "a");
  b.write("x".repeat(64 * 1024 + 1));
  await broker.waitFor((event) => event.type === "disconnected" && event.peer === "b");
  assert.equal(broker.peers.size, 0);
});
