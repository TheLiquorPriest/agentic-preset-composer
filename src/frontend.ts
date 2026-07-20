import type { SpindleFrontendContext, SpindleFrontendTeardown } from "lumiverse-spindle-types"
import { validateSpindleHostDescriptor } from "./compat"
import { setupApcApp } from "./frontend/app"

export function setup(ctx: SpindleFrontendContext): Promise<SpindleFrontendTeardown> {
  validateSpindleHostDescriptor(ctx.host)
  return setupApcApp(ctx)
}
