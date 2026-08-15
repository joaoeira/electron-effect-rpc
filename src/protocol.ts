import * as S from "effect/Schema";
import {
  formatUnknown,
  isRecord,
  isStringValue,
  type IpcEncodedRecord,
  type IpcEncodedValue,
} from "./boundary.ts";

export type RpcSuccessEnvelope = {
  readonly type: "success";
  readonly data: IpcEncodedValue;
};

export type RpcFailureEnvelope = {
  readonly type: "failure";
  readonly error: {
    readonly tag: string;
    readonly data: IpcEncodedValue;
  };
};

export type RpcDefectEnvelope = {
  readonly type: "defect";
  readonly message: string;
  readonly cause?: IpcEncodedValue;
};

export type RpcResponseEnvelope = RpcSuccessEnvelope | RpcFailureEnvelope | RpcDefectEnvelope;

const TaggedValue = S.Struct({
  _tag: S.String,
});

export { formatUnknown, isRecord, isStringValue } from "./boundary.ts";

export function extractErrorTag<T>(error: T): string {
  if (S.is(TaggedValue)(error)) {
    return error._tag;
  }

  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  return "RpcError";
}

export function toDefectEnvelope<T>(cause: T, prefix?: string): RpcDefectEnvelope {
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
  readonly payload: IpcEncodedValue;
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
    readonly data: IpcEncodedValue;
  };
};

export type StreamDefectFrame = {
  readonly type: "defect";
  readonly streamId: string;
  readonly message: string;
};

export type StreamFrame = StreamDataFrame | StreamEndFrame | StreamErrorFrame | StreamDefectFrame;

function hasOwn(record: IpcEncodedRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function extractStreamIdFromRaw<T>(value: T): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const streamId = value.streamId;
  return isStringValue(streamId) ? streamId : null;
}

export function parseStreamFrame<T>(value: T): StreamFrame | null {
  if (!isRecord(value)) {
    return null;
  }

  const streamId = extractStreamIdFromRaw(value);
  if (streamId === null) {
    return null;
  }

  switch (value.type) {
    case "data":
      return hasOwn(value, "payload") ? { type: "data", streamId, payload: value.payload } : null;
    case "end":
      return { type: "end", streamId };
    case "error": {
      const error = value.error;
      if (!isRecord(error) || !isStringValue(error.tag) || !hasOwn(error, "data")) {
        return null;
      }
      return {
        type: "error",
        streamId,
        error: { tag: error.tag, data: error.data },
      };
    }
    case "defect":
      return isStringValue(value.message)
        ? { type: "defect", streamId, message: value.message }
        : null;
    default:
      return null;
  }
}

export function parseRpcResponseEnvelope<T>(value: T): RpcResponseEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.type) {
    case "success":
      return hasOwn(value, "data") ? { type: "success", data: value.data } : null;
    case "failure": {
      const error = value.error;
      if (!isRecord(error) || !isStringValue(error.tag) || !hasOwn(error, "data")) {
        return null;
      }
      return {
        type: "failure",
        error: { tag: error.tag, data: error.data },
      };
    }
    case "defect":
      return isStringValue(value.message)
        ? { type: "defect", message: value.message, cause: value.cause }
        : null;
    default:
      return null;
  }
}
