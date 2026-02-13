import {
  createEventPublisher,
  createRpcEndpoint,
} from "electron-effect-rpc/main";
import {
  createEventSubscriber,
  createRpcClient,
  RpcDefectError,
} from "electron-effect-rpc/renderer";
import {
  createBridgeAdapters,
  exposeRpcBridge,
} from "electron-effect-rpc/preload";
import {
  NoError,
  defineContract,
  event,
  exitSchemaFor,
  rpc,
} from "electron-effect-rpc/contract";
import { createDeferred, createInvokeStub } from "electron-effect-rpc/testing";
import type {
  EventSubscriber,
  IpcMainLike,
  RpcClient,
  RpcEndpoint,
  RpcEventPublisher,
} from "electron-effect-rpc/types";

void createRpcEndpoint;
void createEventPublisher;
void createRpcClient;
void createEventSubscriber;
void exposeRpcBridge;
void createBridgeAdapters;
void RpcDefectError;
void createDeferred;
void createInvokeStub;
void NoError;
void defineContract;
void event;
void exitSchemaFor;
void rpc;

type _SmokeTypes = {
  ipc: IpcMainLike;
  endpoint: RpcEndpoint;
  client: RpcClient<ReturnType<typeof defineContract>>;
  subscriber: EventSubscriber<ReturnType<typeof defineContract>>;
  publisher: RpcEventPublisher<ReturnType<typeof defineContract>>;
};

void (0 as unknown as _SmokeTypes);
