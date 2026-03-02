import type { PluginRuntime } from "openclaw/plugin-sdk";

let _runtime: PluginRuntime | null = null;

export function setDialecticaRuntime(r: PluginRuntime): void {
  _runtime = r;
}

export function getDialecticaRuntime(): PluginRuntime {
  if (!_runtime) throw new Error("Dialectica runtime not initialised");
  return _runtime;
}
