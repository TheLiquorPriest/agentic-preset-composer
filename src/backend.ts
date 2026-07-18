import type { SpindleAPI } from "lumiverse-spindle-types"
import { validateSpindleHostDescriptor } from "./compat"

declare const spindle: SpindleAPI

// Validate the immutable host descriptor before any future APC host API work.
validateSpindleHostDescriptor(spindle.host)
