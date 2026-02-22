export type RpcSuccessEnvelope = {
  readonly type: "success";
  readonly data: unknown;
};

export type RpcFailureEnvelope = {
  readonly type: "failure";
  readonly error: {
    readonly tag: string;
    readonly data: unknown;
  };
};

export type RpcDefectEnvelope = {
  readonly type: "defect";
  readonly message: string;
  readonly cause?: unknown;
};

export type RpcResponseEnvelope = RpcSuccessEnvelope | RpcFailureEnvelope | RpcDefectEnvelope;

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatUnknown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function extractErrorTag(error: unknown): string {
  if (isRecord(error) && typeof error._tag === "string") {
    return error._tag;
  }

  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  return "RpcError";
}

export function toDefectEnvelope(cause: unknown, prefix?: string): RpcDefectEnvelope {
  const causeText = formatUnknown(cause);
  return {
    type: "defect",
    message: prefix ? `${prefix}: ${causeText}` : causeText,
    cause: causeText,
  };
}

export function safelyCall<T>(callback: ((context: T) => void) | undefined, context: T): void {
  if (!callback) {
    return;
  }

  try {
    callback(context);
  } catch {
    // Diagnostics hooks must never crash transport internals.
  }
}

export type StreamDataFrame = {
  readonly type: "data";
  readonly streamId: string;
  readonly payload: unknown;
};

export type StreamEndFrame = {
  readonly type: "end";
  readonly streamId: string;
};

export type StreamErrorFrame = {
  readonly type: "error";
  readonly streamId: string;
  readonly error: {
    readonly tag: string;
    readonly data: unknown;
  };
};

export type StreamDefectFrame = {
  readonly type: "defect";
  readonly streamId: string;
  readonly message: string;
};

export type StreamFrame = StreamDataFrame | StreamEndFrame | StreamErrorFrame | StreamDefectFrame;

export function extractStreamIdFromRaw(value: unknown): string | null {
  if (!isRecord(value) || typeof value.streamId !== "string") {
    return null;
  }
  return value.streamId;
}

export function parseStreamFrame(value: unknown): StreamFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  if (typeof value.streamId !== "string") {
    return null;
  }

  const streamId = value.streamId;

  switch (value.type) {
    case "data":
      if (!hasOwn(value, "payload")) {
        return null;
      }
      return { type: "data", streamId, payload: value.payload };

    case "end":
      return { type: "end", streamId };

    case "error":
      if (
        !isRecord(value.error) ||
        typeof value.error.tag !== "string" ||
        !hasOwn(value.error, "data")
      ) {
        return null;
      }
      return {
        type: "error",
        streamId,
        error: { tag: value.error.tag, data: value.error.data },
      };

    case "defect":
      if (typeof value.message !== "string") {
        return null;
      }
      return { type: "defect", streamId, message: value.message };

    default:
      return null;
  }
}

export function parseRpcResponseEnvelope(value: unknown): RpcResponseEnvelope | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "success":
      if (!hasOwn(value, "data")) {
        return null;
      }

      return {
        type: "success",
        data: value.data,
      };

    case "failure":
      if (!isRecord(value.error) || typeof value.error.tag !== "string") {
        return null;
      }

      if (!hasOwn(value.error, "data")) {
        return null;
      }

      return {
        type: "failure",
        error: {
          tag: value.error.tag,
          data: value.error.data,
        },
      };

    case "defect":
      if (typeof value.message !== "string") {
        return null;
      }

      return {
        type: "defect",
        message: value.message,
        cause: value.cause,
      };

    default:
      return null;
  }
}
