import { exposeRpcBridge } from "../../src/preload.ts";

exposeRpcBridge({ endpoints: ["default", "late", "admin", "worker"] });
