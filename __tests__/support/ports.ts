import type { RpcMessage } from "effect/rpc";
import type { Port, PortListeners } from "../../src/PortProtocol.ts";

type Message = RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded;

/** Values a misbehaving peer might post instead of RPC messages. */
export type Junk = string | null | { readonly _tag: "Request" } | { readonly _tag: "Unknown" };

/**
 * One end of an in-memory message channel with Electron `MessagePortMain`
 * semantics: asynchronous in-order delivery, structured cloning, queueing
 * until `start`, and a close notification delivered to both ends after any
 * messages already in flight.
 */
export class FakePort implements Port {
  peer: FakePort | undefined;
  private listeners: PortListeners | undefined;
  private inbox: Array<Message | Junk> = [];
  closed = false;

  postMessage(message: Message): void {
    const peer = this.peer;
    if (this.closed || peer === undefined || peer.closed) return;
    const data = structuredClone(message);
    setTimeout(() => peer.deliver(data), 0);
  }

  /** Posts a value that is not a valid RPC message. */
  postJunk(junk: Junk): void {
    const peer = this.peer;
    if (peer === undefined) return;
    setTimeout(() => peer.deliver(junk), 0);
  }

  start(listeners: PortListeners): void {
    this.listeners = listeners;
    const pending = this.inbox;
    this.inbox = [];
    for (const data of pending) {
      setTimeout(() => this.deliver(data), 0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const listeners = this.listeners;
    const peer = this.peer;
    setTimeout(() => {
      listeners?.onClose();
      peer?.remoteClosed();
    }, 0);
  }

  private deliver(data: Message | Junk): void {
    if (this.closed) return;
    if (this.listeners === undefined) {
      this.inbox.push(data);
      return;
    }
    this.listeners.onMessage({ data });
  }

  private remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners?.onClose();
  }
}

export interface FakeChannel {
  readonly port1: FakePort;
  readonly port2: FakePort;
}

export const makeChannel = (): FakeChannel => {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
};
