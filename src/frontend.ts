import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(_ctx: SpindleFrontendContext) {
  // Staging's native tab/draft and assembly/generation primitives are reusable only after
  // six complementary gates merge and every matching type release publishes. Deliberately
  // perform no registration, UI mount, storage access, or APC work while those gates remain
  // pending; local bundle preparation grants no APC runtime authority. See DESIGN.md and AUTHOR_BRIEF.md.
  return () => {}
}
