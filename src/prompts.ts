/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.ts";

export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  if (config.promptMode === "append") {
    const identity = parentSystemPrompt || GENERIC_BASE;

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Be concise but complete
- When your task is complete, call report_complete with a summary, status (success/partial/failed), and any artifacts created
- If you get stuck and need input from the parent, call request_help
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    return (
      activeAgentTag +
      envBlock +
      "\n\n<inherited_system_prompt>\n" +
      identity +
      "\n</inherited_system_prompt>\n\n" +
      bridge +
      customSection
    );
  }

  // "replace" mode
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + "\n\n" + config.systemPrompt;
}

const GENERIC_BASE = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
