import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { saveSettings } from "../../src/settings.ts";

const originalWrite = fs.writeFileSync;
const release = fs.openSync(process.argv[4], "r+");
const gate = (phase) => {
  fs.writeSync(1, JSON.stringify({ phase }) + "\n");
  if (fs.readSync(release, Buffer.alloc(1), 0, 1, null) !== 1)
    throw new Error("reader disconnected");
};
// Interpose the actual filesystem write, retaining its flags and permissions.
// The reader runs in another process while this synchronous producer is paused.
fs.writeFileSync = (path, data, options) => {
  const settings = typeof options === "string" ? { encoding: options } : options;
  const fd = fs.openSync(path, settings?.flag ?? "w", settings?.mode);
  try {
    gate("opened");
    const bytes = Buffer.from(data, settings?.encoding ?? "utf8");
    const split = Math.floor(bytes.length / 2);
    originalWrite(fd, bytes.subarray(0, split));
    gate("partial");
    originalWrite(fd, bytes.subarray(split));
    gate("written");
  } finally {
    fs.closeSync(fd);
  }
};
syncBuiltinESMExports();
const persisted = saveSettings(JSON.parse(process.argv[3]), process.argv[2]);
fs.writeSync(1, JSON.stringify({ persisted }) + "\n");
fs.closeSync(release);
process.exitCode = persisted ? 0 : 1;
