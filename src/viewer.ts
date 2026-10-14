import { AsyncLocalStorage } from "node:async_hooks";

export type Role = "desk" | "gm";

/** Who is signed in for the current request. `id` is null for the open local mode and Basic-auth scripts. */
export interface Viewer {
  id: string | null;
  name: string;
  role: Role;
  /** Set when this request comes from a registered shared front-desk PC. */
  device: { id: string; label: string } | null;
  /** Minutes without activity before a desk PC returns to the name picker. */
  idleMinutes: number;
  /** Seconds since this session last did something, so the desk PC countdown survives page reloads. */
  idleFor?: number;
}

// Page templates read the viewer from here (nav by role, the account menu, the desk PC idle timer)
// instead of every page function taking it as a parameter.
const store = new AsyncLocalStorage<Viewer>();
export const runAs = <T>(v: Viewer, fn: () => T): T => store.run(v, fn);
export const currentViewer = (): Viewer | undefined => store.getStore();
export const isGm = (v: Viewer | undefined) => v?.role === "gm";
