/**
 * agent-types.ts — Unified agent type registry.
 */

import { DEFAULT_AGENTS } from "./default-agents.ts";
import type { AgentConfig } from "./types.ts";

export const BUILTIN_TOOL_NAMES: string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

let agents: ReadonlyMap<string, AgentConfig> = new Map();

export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  const next = new Map<string, AgentConfig>();
  for (const [name, config] of DEFAULT_AGENTS) {
    next.set(name, config);
  }
  for (const [name, config] of userAgents) {
    next.set(name, config);
  }
  agents = next;
}

function resolveKey(name: string): string | undefined {
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

export function getAllTypes(): string[] {
  return [...agents.keys()];
}

export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

export function getToolNamesForType(type: string): string[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  return config?.builtinToolNames?.length
    ? config.builtinToolNames
    : [...BUILTIN_TOOL_NAMES];
}

export function getConfig(type: string): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }
  const gp = agents.get("general-purpose");
  if (gp && gp.enabled !== false) {
    return {
      displayName: gp.displayName ?? gp.name,
      description: gp.description,
      builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: gp.extensions,
      skills: gp.skills,
      promptMode: gp.promptMode,
    };
  }
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
    promptMode: "append",
  };
}
