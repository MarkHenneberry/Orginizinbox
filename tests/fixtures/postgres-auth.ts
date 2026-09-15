import { AsyncLocalStorage } from "node:async_hooks";

export const postgresAuth = new AsyncLocalStorage<{ userId: string; providerConnectionId: string }>();
