/** Public Pi 0.73 RPC wire contract. These UI types are not exported by its SDK entrypoint. */
export type ProcessDialogParameters = {
  type: "extension_ui_request";
  title: string;
  timeout?: number;
} & (
  | { method: "select"; options: string[] }
  | { method: "confirm"; message: string }
  | { method: "input"; placeholder?: string }
);
export type ProcessDialogRequest = ProcessDialogParameters & { id: string };
export type ProcessDialogResponse = { type: "extension_ui_response"; id: string } & (
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
);
export interface ProcessDialogDispatch {
  request: ProcessDialogRequest;
  signal: AbortSignal;
  resolve(response: ProcessDialogResponse): void;
  reject(error: unknown): void;
}
