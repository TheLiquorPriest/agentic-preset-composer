import type { SpindleFrontendContext } from "lumiverse-spindle-types"
import { validateSpindleHostDescriptor } from "./compat"

export function setup(ctx: SpindleFrontendContext): () => void {
  validateSpindleHostDescriptor(ctx.host)
  return () => {}
}
