import type { IpcEncodedValue } from "./boundary.ts";
import type { RpcInvoke } from "./types.ts";

export type Invocation = {
  readonly method: string;
  readonly payload: IpcEncodedValue;
};

export type InvokeStub = RpcInvoke & { readonly invocations: Invocation[] };

export const createInvokeStub = (impl: RpcInvoke): InvokeStub => {
  const invocations: Invocation[] = [];

  const wrapped = Object.assign(
    async (method: string, payload: IpcEncodedValue) => {
      invocations.push({ method, payload });
      return impl(method, payload);
    },
    { invocations },
  );

  return wrapped;
};

export const createDeferred = <T, E = Error>() => {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: E) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};
