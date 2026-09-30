import type { RpcMessage } from "effect/rpc";
import type { Port, PortListeners } from "../../src/PortProtocol.ts";

type Message = RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded;

type Delivery = { readonly _tag: "Message"; readonly data: Message } | { readonly _tag: "Close" };

/**
 * One end of a message channel whose deliveries happen only when the test
 * asks for them, so the test decides how messages, closes and user actions
 * interleave. Otherwise it behaves like Electron's `MessagePortMain`: order is
 * preserved per port, messages are structured-cloned, nothing is delivered
 * before `start`, a closed port drops what it would have received, and closing
 * notifies both ends.
 */
export class ControlledPort implements Port {
  peer: ControlledPort | undefined;
  /** Closed locally, or the close from the other end has been delivered. */
  closed = false;
  /** This end's listener has been told the port closed. */
  sawClose = false;
  private readonly inbox: Array<Delivery> = [];
  private listeners: PortListeners | undefined;

  constructor(
    private readonly network: Network,
    readonly side: "client" | "server",
    readonly connection: number,
  ) {}

  postMessage(message: Message): void {
    this.network.activity++;
    if (this.side === "client") {
      this.network.clientPosts.push({
        sequence: this.network.tick(),
        connection: this.connection,
        message,
      });
    }
    const peer = this.peer;
    if (this.closed || peer === undefined || peer.closed) return;
    peer.inbox.push({ _tag: "Message", data: structuredClone(message) });
  }

  start(listeners: PortListeners): void {
    this.listeners = listeners;
  }

  close(): void {
    if (this.closed) return;
    this.network.activity++;
    this.closed = true;
    this.inbox.push({ _tag: "Close" });
    this.peer?.inbox.push({ _tag: "Close" });
  }

  get deliverable(): boolean {
    return this.listeners !== undefined && this.inbox.length > 0;
  }

  deliverNext(): void {
    const listeners = this.listeners;
    const next = this.inbox.shift();
    if (listeners === undefined || next === undefined) return;
    this.network.activity++;
    if (next._tag === "Close") {
      this.closed = true;
      if (this.sawClose) return;
      this.sawClose = true;
      if (this.side !== "client" || !this.network.established.has(this.connection)) {
        listeners.onClose();
        return;
      }
      this.network.drops.push({ connection: this.connection, sequence: this.network.tick() });
      this.network.handlingDrop = true;
      try {
        listeners.onClose();
      } finally {
        this.network.handlingDrop = false;
      }
    } else if (!this.closed) {
      if (this.side === "client") this.observe(next.data);
      listeners.onMessage({ data: next.data });
    }
  }

  private observe(message: Message): void {
    if (message._tag === "Pong") {
      this.network.established.add(this.connection);
    } else if (message._tag === "Defect" && !this.network.established.has(this.connection)) {
      this.network.refusals.push(this.network.tick());
    }
  }
}

export interface Connection {
  readonly client: ControlledPort;
  readonly server: ControlledPort;
}

export interface Post {
  readonly sequence: number;
  readonly connection: number;
  readonly message: Message;
}

export interface Drop {
  readonly connection: number;
  readonly sequence: number;
}

/**
 * All channels of a test run, and what the client observed on them, ordered
 * by a shared sequence number.
 */
export class Network {
  readonly connections: Array<Connection> = [];
  readonly clientPosts: Array<Post> = [];
  /** Connections whose handshake reply reached the client. */
  readonly established = new Set<number>();
  /** Established connections whose close reached the client. */
  readonly drops: Array<Drop> = [];
  /** Refusals that reached the client. */
  readonly refusals: Array<number> = [];
  /**
   * True while the client's close handler for a dropped connection runs.
   * Effect resumes the waiting fiber synchronously, so failing the calls that
   * were in flight, and anything their callers do in response, happens here.
   */
  handlingDrop = false;
  /** Counts posts, closes and deliveries, for detecting when a run is idle. */
  activity = 0;
  private sequence = 0;

  connect(): Connection {
    const index = this.connections.length;
    const client = new ControlledPort(this, "client", index);
    const server = new ControlledPort(this, "server", index);
    client.peer = server;
    server.peer = client;
    const connection = { client, server };
    this.connections.push(connection);
    return connection;
  }

  /** A monotonically increasing number for ordering events in a run. */
  tick(): number {
    return this.sequence++;
  }

  deliverable(): Array<ControlledPort> {
    return this.connections
      .flatMap((connection) => [connection.client, connection.server])
      .filter((port) => port.deliverable);
  }
}
