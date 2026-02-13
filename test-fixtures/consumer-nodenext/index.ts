import {
  NoError as RootNoError,
  createIpcKit,
  defineContract as defineContractRoot,
  event as eventRoot,
  rpc as rpcRoot,
} from "electron-effect-rpc";
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
  exposeIpcBridge,
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
  IpcBridge,
  IpcBridgeGlobal,
  IpcKit,
  IpcKitOptions,
  IpcMainHandle,
  EventSubscriber,
  IpcMainLike,
  RpcClient,
  RpcEndpoint,
  RpcEventPublisher,
} from "electron-effect-rpc/types";

void createRpcEndpoint;
void createEventPublisher;
void createIpcKit;
void createRpcClient;
void createEventSubscriber;
void exposeRpcBridge;
void exposeIpcBridge;
void createBridgeAdapters;
void RpcDefectError;
void createDeferred;
void createInvokeStub;
void NoError;
void RootNoError;
void defineContract;
void defineContractRoot;
void event;
void eventRoot;
void exitSchemaFor;
void rpc;
void rpcRoot;

type _SmokeTypes = {
  bridge: IpcBridge;
  bridgeGlobal: IpcBridgeGlobal<"api">;
  kit: IpcKit<ReturnType<typeof defineContractRoot>>;
  kitOptions: IpcKitOptions<ReturnType<typeof defineContractRoot>>;
  mainHandle: IpcMainHandle<ReturnType<typeof defineContractRoot>>;
  ipc: IpcMainLike;
  endpoint: RpcEndpoint;
  client: RpcClient<ReturnType<typeof defineContract>>;
  subscriber: EventSubscriber<ReturnType<typeof defineContract>>;
  publisher: RpcEventPublisher<ReturnType<typeof defineContract>>;
};

void (0 as unknown as _SmokeTypes);
