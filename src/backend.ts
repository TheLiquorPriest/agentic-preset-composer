import type { SpindleAPI } from "lumiverse-spindle-types"
import { setup } from "./backend/runtime"

declare const spindle: SpindleAPI

// The host awaits the entry module; startup therefore cannot expose a partially
// initialized interceptor or frontend transport.
const runtime = setup(spindle)
await runtime.ready

export { runtime }
export const teardown = (): Promise<void> => runtime.dispose()
