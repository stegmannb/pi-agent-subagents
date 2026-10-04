import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ProcessCommunication } from "../../../src/process-communication.ts";

// Same child, same result, two actual broker deliveries before its prompt resolves.
// This changes only the test import path. Production does not retry publication.
const publish = ProcessCommunication.prototype.publish;
ProcessCommunication.prototype.publish = async function (result) {
  await publish.call(this, result);
  if (process.env.PASA_QUALIFICATION_DUPLICATE !== "1") return;
  appendFileSync(
    join(process.env.PASA_LIFE_REGISTRY, "qualification-redelivery.jsonl"),
    JSON.stringify({ pid: process.pid, delivery: 1, result }) + "\n",
  );
  await publish.call(this, result);
  appendFileSync(
    join(process.env.PASA_LIFE_REGISTRY, "qualification-redelivery.jsonl"),
    JSON.stringify({ pid: process.pid, delivery: 2, result }) + "\n",
  );
};
