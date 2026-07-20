export const HOST_INTERCEPTOR_WALL_MS = 300_000
export const FINALIZATION_RESERVE_MS = 15_000
export const GRAPH_DEADLINE_MS = 285_000
export const DEFAULT_RUN_TIMEOUT_MS = 60_000
export const MIN_RUN_TIMEOUT_MS = 1_000
export const MAX_RUN_TIMEOUT_MS = 240_000
export const HOST_NONCOMMIT_CANCEL_GRACE_MS = 1_000

export const MAX_CONFIG_BYTES = 1_048_576
export const MAX_CONNECTION_SLOTS = 16
export const MAX_THREADS = 16
export const MAX_STAGES_PER_PIPELINE = 32
export const MAX_RUNS_PER_PIPELINE = 64
export const MAX_PARALLEL_WIDTH = 4
export const MAX_BLOCKS_PER_THREAD = 128
export const MAX_BINDINGS_PER_RUN = 32
export const MAX_FINAL_INPUTS = 32
export const MAX_ACTIVE_PER_USER_PRESET = 8
export const MAX_ACTIVE_GLOBAL = 32
export const MAX_NAME_CHARS = 80
export const MAX_DESCRIPTION_BYTES = 2_048
export const MAX_LITERAL_BYTES = 32_768
export const MAX_BLOCK_CONTENT_BYTES = 131_072
export const MAX_THREAD_OUTPUT_BYTES = 262_144
export const MAX_WORKSPACE_BYTES = 4_194_304
export const MAX_GUIDANCE_BYTES = 1_048_576
export const TRACE_PREVIEW_BYTES = 4_096
export const MAX_TRACE_BYTES = 131_072
export const MAX_TRACE_TOTAL_BYTES = 8_388_608
export const MAX_RETAINED_TRACES_PER_USER_PRESET = 20
export const MAX_RETAINED_TRACES_GLOBAL = 100
export const MAX_RETRIEVAL_SNAPSHOT_BYTES = 4_194_304
export const MAX_PROVIDER_RAW_BYTES = 131_072
export const MAX_TOOL_SIGNATURE_BYTES = 131_072

const UTF8_ENCODER = new TextEncoder()

export function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength
}

export function characterCount(value: string): number {
  return Array.from(value).length
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) {
    throw new RangeError("maxBytes must be finite")
  }
  if (maxBytes <= 0 || value.length === 0) {
    return ""
  }

  const byteLimit = Math.floor(maxBytes)
  if (byteLimit <= 0) {
    return ""
  }
  if (utf8Bytes(value) <= byteLimit) {
    return value
  }

  let bytes = 0
  let end = 0
  for (const codePoint of value) {
    const codePointBytes = utf8Bytes(codePoint)
    if (bytes + codePointBytes > byteLimit) {
      break
    }
    bytes += codePointBytes
    end += codePoint.length
  }
  return value.slice(0, end)
}
