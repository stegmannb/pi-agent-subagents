/** Test-owned stderr journal. Read a bounded prefix and emit only validated fixed observations. */
import { open } from "node:fs/promises";
import {
  isInspectionDiagnostic,
  type InspectionDiagnostic,
} from "../../src/process-inspection-diagnostic.ts";
export async function inspectionJournal(
  path: string,
  emit = true,
): Promise<InspectionDiagnostic[]> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return [];
  try {
    const buffer = Buffer.alloc(262144);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const records: InspectionDiagnostic[] = [];
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.startsWith("PASA_INSPECTION ") || line.length > 512 || records.length >= 512)
        continue;
      try {
        const record: unknown = JSON.parse(line.slice("PASA_INSPECTION ".length));
        if (!isInspectionDiagnostic(record)) continue;
        records.push(record);
        if (emit) console.log("PASA_INSPECTION " + JSON.stringify(record));
      } catch {
        /* No foreign stderr is forwarded as a diagnostic. */
      }
    }
    return records;
  } finally {
    await file.close();
  }
}
