import { AsyncLocalStorage } from "node:async_hooks";

/** A borrowed normal attachment can carry a single, explicitly narrowed recovery request. */
const requests = new AsyncLocalStorage<boolean>();
export function inRecoveryRequest(): boolean {
  return requests.getStore() === true;
}
export function withRecoveryRequest<T>(callback: () => T): T {
  return requests.run(true, callback);
}
