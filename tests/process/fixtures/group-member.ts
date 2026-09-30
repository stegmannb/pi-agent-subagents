import { LocalMessageClient } from "../../../src/messaging-client.ts";
let client: LocalMessageClient;
process.on("message", async (message: any) => {
  try {
    let value: unknown;
    if (message.operation === "connect") {
      client = await LocalMessageClient.connect(message.input);
      value = { pid: process.pid };
    } else if (message.operation === "event") {
      await client.event(message.input.to, message.input.payload).received;
      value = null;
    } else if (message.operation === "receive") value = await client.nextMessage();
    else value = await client.control(message.operation, message.input);
    process.send?.({ id: message.id, value });
  } catch (error) {
    process.send?.({ id: message.id, error: (error as any).code ?? "FAILED" });
  }
});
process.on("disconnect", () => {
  client?.close();
  process.exit(0);
});
