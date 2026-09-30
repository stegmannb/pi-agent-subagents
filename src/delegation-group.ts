import { randomUUID } from "node:crypto";
import { isId, isRecord, TransportError, type Participant } from "./messaging-protocol.ts";
import type { ProcessRole } from "./process-profile.ts";

export interface GroupBinding extends Participant {
  taskId: string;
  processId: string;
  depth: number;
  role: ProcessRole;
  maxConcurrent: number;
  maxDepth: number;
  active: boolean;
}
/** Lives only in the root broker. All mutations are synchronous and atomic in its event loop. */
export class DelegationGroup {
  readonly members = new Map<string, GroupBinding>();
  readonly root: GroupBinding;
  constructor(root: GroupBinding) {
    this.root = root;
    for (const value of [root.maxConcurrent, root.maxDepth])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new TransportError("INVALID_GROUP_LIMIT");
    this.members.set(root.agentId, root);
  }
  reserve(parentId: string, input: unknown): GroupBinding {
    const parent = this.members.get(parentId);
    if (!parent?.active || parent.role.readOnly) throw new TransportError("FORBIDDEN");
    if (
      !isRecord(input) ||
      !isId(input.taskId) ||
      !isRecord(input.role) ||
      typeof input.role.name !== "string" ||
      !input.role.name ||
      typeof input.role.readOnly !== "boolean" ||
      !Array.isArray(input.role.allowedTools) ||
      input.role.allowedTools.some(
        (t) => typeof t !== "string" || !parent.role.allowedTools.includes(t),
      )
    )
      throw new TransportError("FORBIDDEN");
    const depth = parent.depth + 1;
    const maxDepth = input.maxDepth ?? parent.maxDepth;
    const maxConcurrent = input.maxConcurrent ?? parent.maxConcurrent;
    for (const [value, ceiling] of [
      [maxDepth, parent.maxDepth],
      [maxConcurrent, parent.maxConcurrent],
    ] as Array<[unknown, number]>)
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ceiling)
        throw new TransportError("INVALID_GROUP_LIMIT");
    if (depth > (maxDepth as number)) throw new TransportError("DEPTH_EXCEEDED");
    this.capacity(maxConcurrent as number);
    const role = input.role as unknown as ProcessRole;
    const binding: GroupBinding = {
      groupId: parent.groupId,
      parentId,
      agentId: randomUUID(),
      sessionId: randomUUID(),
      processId: randomUUID(),
      taskId: input.taskId,
      depth,
      role: { name: role.name, readOnly: role.readOnly, allowedTools: [...role.allowedTools] },
      maxConcurrent: maxConcurrent as number,
      maxDepth: maxDepth as number,
      active: true,
    };
    if (
      binding.role.readOnly &&
      binding.role.allowedTools.some((t) => !["read", "grep", "find", "ls"].includes(t))
    )
      throw new TransportError("FORBIDDEN");
    this.members.set(binding.agentId, binding);
    return binding;
  }
  resume(parentId: string, agentId: string, connected = false): GroupBinding {
    const parent = this.members.get(parentId);
    const member = this.members.get(agentId);
    if (!parent?.active || parent.role.readOnly || member?.parentId !== parentId)
      throw new TransportError("FORBIDDEN");
    if (member.active || connected) throw new TransportError("SESSION_BUSY");
    this.capacity(member.maxConcurrent);
    member.processId = randomUUID();
    member.active = true;
    return member;
  }
  release(parentId: string, agentId: string, processId: string): void {
    const member = this.members.get(agentId);
    if (!member || member.parentId !== parentId || member.processId !== processId)
      throw new TransportError("FORBIDDEN");
    member.active = false;
  }
  private capacity(limit: number): void {
    const active = [...this.members.values()].filter((m) => m.parentId !== null && m.active).length;
    if (active >= Math.min(limit, this.root.maxConcurrent))
      throw new TransportError("CONCURRENCY_LIMIT");
  }
}
