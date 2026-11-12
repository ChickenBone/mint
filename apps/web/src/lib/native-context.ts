import { AsyncLocalStorage } from "node:async_hooks";

type NativeUser = { id: string; email: string; name: string; role: "user"; status: "active" };
export type NativeContext = { user: NativeUser; sessionHash: string; request: Request; installationId?: string; deviceName?: string };
const context = new AsyncLocalStorage<NativeContext>();

export function runNativeRequest<T>(value: NativeContext, handle: () => T): T {
  return context.run(value, handle);
}
export const currentNativeContext = () => context.getStore();
export const isNativeTransportRequest = (request: Request) => context.getStore()?.request === request;

export function validConsumerMutation(request: Request, origin: string) {
  return isNativeTransportRequest(request) ||
    request.headers.get("origin") === new URL(origin).origin;
}
