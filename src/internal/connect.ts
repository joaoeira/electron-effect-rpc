/**
 * Identifies connection requests. Used as the IPC channel between preload and
 * main, and as the `_tag` of the request message on every hop.
 */
export const connectTag = "electron-effect-rpc/connect";

export const defaultEndpoint = "default";

export interface ConnectRequest {
  readonly _tag: typeof connectTag;
  readonly endpoint: string;
}

export const connectRequest = (endpoint: string): ConnectRequest => ({
  _tag: connectTag,
  endpoint,
});

/**
 * Sent on a port before closing it to refuse the connection. A `Defect`
 * received before the handshake completes tells the client not to retry.
 */
export const rejection = (reason: string) => ({ _tag: "Defect", defect: reason }) as const;
