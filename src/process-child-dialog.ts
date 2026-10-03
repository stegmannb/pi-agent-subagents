import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@mariozechner/pi-coding-agent";
import type { ProcessDialogParameters, ProcessDialogResponse } from "./process-dialog.ts";

/** Public UI methods with private IPC correlation, including the SDK's local cancellation. */
export function createChildDialogs(send: (message: unknown) => void, ownsRun: () => boolean) {
  const pending = new Map<string, (response: ProcessDialogResponse) => void>();
  function ask(
    request: ProcessDialogParameters,
    options?: ExtensionUIDialogOptions,
  ): Promise<ProcessDialogResponse> {
    const id = randomUUID();
    const cancelled: ProcessDialogResponse = { type: "extension_ui_response", id, cancelled: true };
    if (options?.signal?.aborted) return Promise.resolve(cancelled);
    if (!ownsRun()) return Promise.reject(new Error("PROCESS_IDENTITY_UNPROVEN"));
    if (pending.size >= 16) return Promise.reject(new Error("DIALOG_CAPACITY"));
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (response: ProcessDialogResponse) => {
        if (!pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        resolve(response);
      };
      const cancel = () => {
        finish(cancelled);
        send({ type: "dialog_cancel", id });
      };
      pending.set(id, finish);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeout) timer = setTimeout(cancel, options.timeout);
      send({ type: "dialog_request", request: { ...request, id, timeout: options?.timeout } });
    });
  }
  const ui: Pick<ExtensionUIContext, "select" | "confirm" | "input"> = {
    select: async (title, options, opts) => {
      const response = await ask(
        { type: "extension_ui_request", method: "select", title, options },
        opts,
      );
      return "value" in response ? response.value : undefined;
    },
    input: async (title, placeholder, opts) => {
      const response = await ask(
        { type: "extension_ui_request", method: "input", title, placeholder },
        opts,
      );
      return "value" in response ? response.value : undefined;
    },
    confirm: async (title, message, opts) => {
      const response = await ask(
        { type: "extension_ui_request", method: "confirm", title, message },
        opts,
      );
      return "confirmed" in response ? response.confirmed : false;
    },
  };
  return {
    ui,
    reply(response: ProcessDialogResponse) {
      pending.get(response.id)?.(response);
    },
  };
}
