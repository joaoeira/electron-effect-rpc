import type {
  EventSubscribe,
  IpcEncodedValue,
  IpcInvokeEvent,
  IpcInvokeResult,
  OnStreamFrame,
  RpcInvoke,
} from "../src/types.ts";

export type {
  DecodeFailureContext,
  DispatchFailureContext,
  DroppedEventContext,
  IpcEncodedValue,
  IpcInvokeEvent,
  IpcInvokeResult,
  IpcMainLike,
  ProtocolErrorContext,
} from "../src/types.ts";

export { formatUnknown, isFunctionValue, isRecord, isStringValue } from "../src/boundary.ts";

export type ExposedTestApi = {
  readonly invoke?: RpcInvoke;
  readonly subscribe?: EventSubscribe;
  readonly onStreamFrame?: OnStreamFrame;
};

export type IpcTestListener = (event: IpcInvokeEvent, payload: IpcEncodedValue) => IpcInvokeResult;
