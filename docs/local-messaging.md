# Local process messaging v1

`src/messaging-broker.ts`, `src/messaging-client.ts` and
`src/messaging-protocol.ts` implement a generic Unix socket transport. They have
no Pi or model dependency. The existing runner and tools do not use this API yet.
The transport does not start processes, manage worktrees, or persist sessions.

## API

```ts
import { LocalMessageBroker } from "./src/messaging-broker.ts";
import { LocalMessageClient } from "./src/messaging-client.ts";

const broker = await LocalMessageBroker.start();
const parentKey = broker.register({
  groupId: "group-1", agentId: "parent", parentId: null, sessionId: "session-1",
});
const childKey = broker.register({
  groupId: "group-1", agentId: "child", parentId: "parent", sessionId: "session-2",
});
const parent = await LocalMessageClient.connect(parentKey);
const child = await LocalMessageClient.connect(childKey);
try {
  const answer = parent.request("child", { taskId: "task-42", question: "Ready?" });
  const request = await child.nextMessage();
  const reply = child.reply(request, { ready: true });
  await reply.accepted; // Broker queued the reply to the parent's socket.
  await reply.received; // Parent transport received it, independent of any model turn.
  console.log((await answer).payload);
} finally {
  parent.close();
  child.close();
  await broker.close();
}
```

The owner registers participants before handing out credentials. `agentId` is
unique within a broker. Parent registration must already exist in the same
`groupId`. Every registered member can address every member of its group,
including siblings and itself; `parentId` does not grant additional privileges.
Different groups cannot communicate. `sessionId` is metadata, not an address.
A task identifier belongs in the application payload; a PID belongs in the
runner. Neither is used as agent or session identity.

`register()` returns `{ socketPath, capability }`, containing a random 256-bit
capability for exactly one participant. Keep it private and pass it only to that
participant. The broker's `/tmp/pasa-*/s` lives in a directory with mode `0700`;
the socket has mode `0600`. There is no TCP listener. Filesystem permissions
isolate OS users, not hostile processes running as the same OS user. Capabilities
bind senders but do not encrypt traffic or protect against that user's debugger.
The transport emits no logs and error messages contain fixed codes, never frames,
payloads or capabilities. Do not log credentials in caller code.

The client provides:

- `request(to, payload, { timeoutMs?, messageId? })`: a promise for the correlated
  reply envelope. The transport resolves it directly, without `nextMessage()`
  or a model turn. Explicit message IDs permit later cancellation.
- `event(to, payload)`, `reply(requestEnvelope, payload)` and
  `cancel(to, correlationId, payload = null)`: a `DeliveryHandle` with `messageId`,
  `accepted` and `received` promises.
- `send(envelope)`: the low-level equivalent, including explicit IDs for retries.
  A second locally pending delivery with the same ID is rejected.
- `nextMessage(timeoutMs?)`: consume the bounded inbox of requests, events and
  cancellation notifications. Replies never enter this inbox.
- `close()`: terminate this client, reject pending operations, discard its inbox.
- `broker.close()`: idempotent asynchronous shutdown, rejecting connected clients
  and deleting its private socket directory. An absolute 100 ms socket deadline
  bounds graceful draining even if a peer keeps writing.

Local argument/state errors may throw synchronously. Wire rejection, timeout and
connection loss reject the returned promises. Every delivery stage can be awaited
independently; unused stages do not produce unhandled promise rejections.

## Wire contract

Each frame is one UTF-8 JSON object followed by LF. The size limit excludes LF.
Frames can span reads, including UTF-8 codepoints, and a read can contain several
frames. Empty lines, malformed JSON, invalid UTF-8, unsupported versions and
oversized frames close that connection. Unknown fields are ignored in v1.

All frames carry `version: 1`. A client first sends
`{ version: 1, type: "hello", capability }`. The broker responds with
`{ version: 1, type: "ready", participant, limits }`. Identity comes exclusively
from the owner's capability registration, never from the hello frame.

Application frames use `{ version: 1, type: "send", envelope }` and arrive as
`{ version: 1, type: "message", envelope }`. The envelope is:

```ts
interface Envelope {
  version: 1;
  messageId: string;
  kind: "request" | "reply" | "event" | "cancel";
  from: string;
  to: string;
  correlationId?: string; // Required for reply/cancel; absent otherwise.
  payload: Json;
  timeoutMs?: number; // Required only for request, positive and within broker limit.
}
```

IDs match `[A-Za-z0-9_.:-]{1,128}`. `from` must match the authenticated agent.
Reply correlation refers to an open request from `to` to `from`. Cancellation
refers to the sender's open request to that same recipient. Only the original
requester can cancel. Cancellation rejects its request with `CANCELLED` and
queues a cancellation envelope to the recipient. Stopping application work is
the recipient's responsibility. A late or unrelated reply/cancel is rejected.

Delivery has three distinct stages:

1. The broker queues a frame within the recipient's write budget and returns
   `{ version: 1, type: "accepted", messageId }` to the sender.
2. The recipient transport queues the message in its bounded inbox, or resolves
   a reply directly, then sends
   `{ version: 1, type: "received", messageId, from }` to the broker. The broker
   verifies the recipient and forwards `received` with `messageId` to the sender.
3. Application code produces a new `reply` envelope with its own `messageId`
   and the request ID as `correlationId`.

Acceptance is not receipt. Receipt is not model observation, task success or a
promise to reply. The broker trusts an authenticated recipient's receipt claim.

Dedupe is keyed by sender plus message ID. Its fingerprint is SHA-256 of the
normalized envelope's JSON serialization, including payload key order. Resending
that same envelope within the retention window replays acceptance and any known
receipt without delivering again. Reusing the ID with different contents fails
with `DUPLICATE_CONFLICT`. Payload object key reordering counts as a change.
Completed reply payloads are not stored or replayed. A retry after expiry can
be delivered again; this is bounded duplicate suppression, not exactly-once
execution or recovery. Use fresh IDs for new requests.

## Bounds and backpressure

`LocalMessageBroker.start(partialLimits)` and
`LocalMessageClient.connect(credential, partialLimits)` accept finite positive
integer limits. Client limits become the smaller of its own and the broker's
advertised values. Overrides above 2147483647 are rejected to avoid timer overflow.
The write queue must fit a maximum frame plus LF. Configure frame limits large
enough for the ready frame and metadata as well as application messages.

| Limit | Default | Scope |
| --- | ---: | --- |
| `maxFrameBytes` | 65536 | One encoded frame, each direction |
| `maxQueueBytes` | 262144 | Each socket's Node write buffer; separately each client's inbox bytes |
| `maxInboxMessages` | 128 | Each client inbox |
| `maxPending` | 256 | Each client's delivery, request and inbox-wait maps independently; broker requests per sender |
| `maxParticipants` | 128 | Broker registrations, retained for its lifetime |
| `maxConnections` | 128 | Broker sockets, including unauthenticated connections |
| `maxDedupeEntries` | 4096 | Broker delivery records plus reserved terminal slots |
| `dedupeTtlMs` | 60000 | Minimum delivery-record lifetime from acceptance |
| `requestTimeoutMs` | 30000 | Default and maximum request, receipt and inbox wait |
| `handshakeTimeoutMs` | 5000 | Authentication/connection deadline |

The broker retains only identity/correlation metadata and fingerprints, not
payloads. Expired records are pruned on subsequent protocol activity; open
requests remain until termination even if their dedupe TTL passes. Each admitted
request reserves one additional record for its eventual reply or cancel. Events
and new requests cannot consume that reservation. Full capacity rejects new
work with `CAPACITY` without evicting unexpired dedupe records. A configuration
with one dedupe slot can carry events but cannot admit requests.

A slow reader that exhausts its socket's write budget is disconnected. Other
sockets continue independently; routing never awaits application handlers. A
client that cannot fit a message in its inbox closes with local `CAPACITY`;
other participants observe `TARGET_DISCONNECTED`. A connection over the broker
connection limit is closed before authentication. The client sees
`BROKER_DISCONNECTED`. Kernel socket buffers add finite OS-managed buffering
outside the configured Node write budget. Per-frame parsing runs synchronously
and is bounded by the frame size; this is not a CPU rate limiter or a fairness
scheduler across untrusted peers.

## Failure semantics

Errors are `TransportError` with a stable `code`. On the wire they use
`{ version: 1, type: "error", code, messageId? }`. An error without a message ID
ends the connection. These codes do not include user-supplied text.

| Code | Meaning |
| --- | --- |
| `PROTOCOL_ERROR`, `FRAME_TOO_LARGE` | Invalid frame/schema/version or byte limit |
| `AUTH_FAILED`, `ALREADY_CONNECTED` | Invalid capability or participant already online |
| `SENDER_MISMATCH` | Envelope sender differs from authenticated identity |
| `UNKNOWN_TARGET`, `FORBIDDEN` | Target is unregistered or belongs to another group |
| `DUPLICATE_CONFLICT` | Reused ID with different content, identity already registered, or local duplicate operation |
| `INVALID_CORRELATION` | Reply/cancel lacks a matching open request, or receipt claims another recipient's message |
| `CAPACITY` | Configured resource budget exhausted |
| `TIMEOUT` | Request, receipt, inbox or authentication deadline elapsed |
| `CANCELLED` | Requester cancelled an open request |
| `TARGET_DISCONNECTED` | Recipient is offline or disconnected during a pending operation |
| `DISCONNECTED` | This client was explicitly closed |
| `BROKER_CLOSED` | Client received the broker's graceful shutdown frame |
| `BROKER_DISCONNECTED` | Broker socket disappeared or could not be connected |

A request deadline starts locally when called and independently at the broker
when accepted. The first terminal result wins. Timeout does not stop application
work; use cancellation before timeout when that is needed. Orphan replies racing
a local timeout are acknowledged and discarded, never sent to the model inbox.
A peer loss fails all open calls to that peer. Graceful shutdown is best effort;
a broken or saturated connection may observe `BROKER_DISCONNECTED` instead of
the shutdown frame. Transport errors do not prove whether application work ran.

There is no automatic reconnect, durable mailbox or broker-loss recovery. A
caller can explicitly open a fresh client with an existing registration after
its old connection is gone, but pending operations and inbox contents are lost.
No replay or continuation guarantee is made. A new broker needs new capabilities.

## Validation

`pnpm test` includes `src/messaging.test.ts` in the existing test path and named
`test:unit` devenv task. Tests use local sockets and deterministic peers, without
Pi, models, credentials or network services. They cover permissions, capability
authentication, parent/child and sibling routing, all delivery stages, malformed
and fragmented frames, correlations, parallel requests, dedupe retention and
capacity, cancellation, deadlines, disconnection, shutdown, a continuously
writing peer, and an unread socket alongside healthy peers. Unix sockets require
a Unix platform; Windows named pipes are not implemented.
