import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dialecticaChannelPlugin } from "./src/channel.js";
import { setDialecticaRuntime } from "./src/runtime.js";

const plugin = {
  id: "dialectica",
  name: "Dialectica",
  description: "WebSocket channel plugin for Dialectica knowledge marketplace (ISP + IVSP roles)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDialecticaRuntime(api.runtime as unknown as PluginRuntime);
    api.registerChannel({ plugin: dialecticaChannelPlugin });
  },
};

export default plugin;
