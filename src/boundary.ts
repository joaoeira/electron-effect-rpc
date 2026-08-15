import * as Predicate from "effect/Predicate";

/** Values supported by Electron's structured-clone IPC transport. */
export type IpcEncodedValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | RegExp
  | Error
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView
  | ReadonlyArray<IpcEncodedValue>
  | ReadonlyMap<IpcEncodedValue, IpcEncodedValue>
  | ReadonlySet<IpcEncodedValue>
  | IpcEncodedRecord;

export type IpcEncodedRecord = {
  readonly [key: string]: IpcEncodedValue;
};

/** True for non-null, non-array objects. Arrays are not IPC records. */
export function isRecord<T>(value: T): value is T & IpcEncodedRecord {
  return Predicate.isObject(value);
}

function isPrimitiveIpcValue<T>(value: T): boolean {
  return (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBigInt(value) ||
    Predicate.isBoolean(value) ||
    value === null ||
    value === undefined
  );
}

function isIpcEncodedValueInternal<T>(value: T, visited: WeakSet<object>): boolean {
  if (isPrimitiveIpcValue(value)) {
    return true;
  }

  if (!Predicate.isObjectOrArray(value)) {
    return false;
  }

  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return true;
  }

  if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
    return false;
  }

  if (visited.has(value)) {
    return true;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isIpcEncodedValueInternal(item, visited));
  }

  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (!isIpcEncodedValueInternal(key, visited) || !isIpcEncodedValueInternal(item, visited)) {
        return false;
      }
    }
    return true;
  }

  if (value instanceof Set) {
    for (const item of value) {
      if (!isIpcEncodedValueInternal(item, visited)) {
        return false;
      }
    }
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  for (const key of Object.keys(value)) {
    if (!isIpcEncodedValueInternal(value[key], visited)) {
      return false;
    }
  }
  return true;
}

export function isIpcEncodedValue<T>(value: T): value is T & IpcEncodedValue {
  return isIpcEncodedValueInternal(value, new WeakSet());
}

export function isStringValue<T>(value: T): value is T & string {
  return Predicate.isString(value);
}

export function isNumberValue<T>(value: T): value is T & number {
  return Predicate.isNumber(value);
}

export function isFunctionValue<T>(value: T): boolean {
  return Predicate.isFunction(value);
}

export function formatUnknown<T>(value: T): string {
  return value instanceof Error ? value.message : String(value);
}

export function parseIpcEncodedValue<T>(value: T): IpcEncodedValue | null {
  return isIpcEncodedValue(value) ? value : null;
}

/** Values reported through diagnostics after transport-safe normalization. */
export type DiagnosticCause = IpcEncodedValue;

export function toDiagnosticCause<T>(value: T): DiagnosticCause {
  if (value instanceof Error) {
    return value;
  }
  const parsed = parseIpcEncodedValue(value);
  return parsed !== null ? parsed : formatUnknown(value);
}
