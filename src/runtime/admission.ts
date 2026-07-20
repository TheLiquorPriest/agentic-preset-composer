import {
  MAX_ACTIVE_GLOBAL,
  MAX_ACTIVE_PER_USER_PRESET,
} from "../config/limits"

/** The identity that owns one APC execution. */
export interface AdmissionKey {
  readonly userId: string
  readonly presetId: string
  readonly executionId: string
}

/** A read-only lease returned only after an execution has been admitted. */
export interface AdmissionLease extends AdmissionKey {
  readonly leaseId: number
}

export type AdmissionRejectionReason =
  | "invalid-key"
  | "already-active"
  | "replacement-invalid"
  | "user-preset-capacity"
  | "global-capacity"

export interface AdmissionAcquireOptions {
  /** An active lease that must be atomically replaced by the new execution. */
  readonly replacing?: AdmissionLease
}

export type AdmissionResult =
  | Readonly<{
      readonly accepted: true
      readonly admission: AdmissionLease
    }>
  | Readonly<{
      readonly accepted: false
      readonly reason: AdmissionRejectionReason
    }>

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0
}

function isValidKey(userId: unknown, presetId: unknown, executionId: unknown): boolean {
  return isValidId(userId) && isValidId(presetId) && isValidId(executionId)
}

function freezeKey(userId: string, presetId: string, executionId: string): AdmissionKey {
  return Object.freeze({ userId, presetId, executionId })
}

function invalidKeyResult(): AdmissionResult {
  return Object.freeze({ accepted: false, reason: "invalid-key" as const })
}

function replacementInvalidResult(): AdmissionResult {
  return Object.freeze({ accepted: false, reason: "replacement-invalid" as const })
}

/**
 * In-memory active-execution admission. Maps are deliberately nested by user
 * before preset and execution so a caller can never resolve an execution in
 * another user's namespace by supplying colliding IDs.
 */
export class AdmissionRegistry {
  private readonly byUser = new Map<string, Map<string, Map<string, AdmissionLease>>>()
  private activeCount = 0
  private nextLeaseId = 1

  acquire(
    userId: string,
    presetId: string,
    executionId: string,
    options: AdmissionAcquireOptions = {},
  ): AdmissionResult {
    if (!isValidKey(userId, presetId, executionId)) return invalidKeyResult()

    const replacing = options.replacing
    if (replacing !== undefined) {
      if (
        !isValidKey(replacing.userId, replacing.presetId, replacing.executionId) ||
        !Number.isSafeInteger(replacing.leaseId) ||
        replacing.leaseId <= 0 ||
        replacing.userId !== userId ||
        replacing.presetId !== presetId ||
        replacing.executionId === executionId
      ) return replacementInvalidResult()
      const current = this.byUser.get(userId)?.get(presetId)?.get(replacing.executionId)
      if (current === undefined || current.leaseId !== replacing.leaseId) return replacementInvalidResult()
    }

    let byPreset = this.byUser.get(userId)
    let byExecution = byPreset?.get(presetId)
    if (byExecution?.has(executionId)) {
      return Object.freeze({ accepted: false, reason: "already-active" as const })
    }

    const replacingActive = replacing !== undefined
    const effectivePresetSize = (byExecution?.size ?? 0) - (replacingActive ? 1 : 0)
    if (effectivePresetSize >= MAX_ACTIVE_PER_USER_PRESET) {
      return Object.freeze({ accepted: false, reason: "user-preset-capacity" as const })
    }
    if (this.activeCount - (replacingActive ? 1 : 0) >= MAX_ACTIVE_GLOBAL) {
      return Object.freeze({ accepted: false, reason: "global-capacity" as const })
    }

    if (replacing !== undefined) {
      byExecution?.delete(replacing.executionId)
      this.activeCount -= 1
    }
    if (!byPreset) {
      byPreset = new Map()
      this.byUser.set(userId, byPreset)
    }
    if (!byExecution) {
      byExecution = new Map()
      byPreset.set(presetId, byExecution)
    }

    const admission = Object.freeze({
      ...freezeKey(userId, presetId, executionId),
      leaseId: this.nextLeaseId,
    })
    this.nextLeaseId += 1
    byExecution.set(executionId, admission)
    this.activeCount += 1

    return Object.freeze({ accepted: true as const, admission })
  }

  replace(
    replacing: AdmissionLease,
    userId: string,
    presetId: string,
    executionId: string,
  ): AdmissionResult {
    return this.acquire(userId, presetId, executionId, { replacing })
  }

  release(userId: string, presetId: string, executionId: string): boolean {
    return this.settle(userId, presetId, executionId)
  }

  cancel(userId: string, presetId: string, executionId: string): boolean {
    return this.settle(userId, presetId, executionId)
  }

  get(userId: string, presetId: string, executionId: string): AdmissionLease | undefined {
    if (!isValidKey(userId, presetId, executionId)) return undefined
    return this.byUser.get(userId)?.get(presetId)?.get(executionId)
  }

  list(userId: string, presetId?: string): readonly AdmissionLease[] {
    if (!isValidId(userId)) return Object.freeze([])
    const byPreset = this.byUser.get(userId)
    if (!byPreset) return Object.freeze([])

    const leases: AdmissionLease[] = []
    if (presetId !== undefined) {
      if (!isValidId(presetId)) return Object.freeze([])
      const byExecution = byPreset.get(presetId)
      if (byExecution) leases.push(...byExecution.values())
    } else {
      for (const byExecution of byPreset.values()) leases.push(...byExecution.values())
    }
    return Object.freeze(leases.slice())
  }

  /** Used by the trace store to relinquish a lease after storage rejection. */
  releaseLease(admission: AdmissionLease): boolean {
    if (!isValidKey(admission.userId, admission.presetId, admission.executionId)) return false
    if (!Number.isSafeInteger(admission.leaseId) || admission.leaseId <= 0) return false
    const byPreset = this.byUser.get(admission.userId)
    const byExecution = byPreset?.get(admission.presetId)
    const current = byExecution?.get(admission.executionId)
    if (!current || current.leaseId !== admission.leaseId) return false
    byExecution?.delete(admission.executionId)
    this.removeEmpty(admission.userId, admission.presetId, byPreset, byExecution)
    this.activeCount -= 1
    return true
  }

  private settle(userId: string, presetId: string, executionId: string): boolean {
    if (!isValidKey(userId, presetId, executionId)) return false
    const byPreset = this.byUser.get(userId)
    const byExecution = byPreset?.get(presetId)
    if (!byExecution?.has(executionId)) return false
    byExecution.delete(executionId)
    this.removeEmpty(userId, presetId, byPreset, byExecution)
    this.activeCount -= 1
    return true
  }

  private removeEmpty(
    userId: string,
    presetId: string,
    byPreset: Map<string, Map<string, AdmissionLease>> | undefined,
    byExecution: Map<string, AdmissionLease> | undefined,
  ): void {
    if (byExecution && byExecution.size === 0) byPreset?.delete(presetId)
    if (byPreset && byPreset.size === 0) this.byUser.delete(userId)
  }
}

export function acquireAdmission(
  registry: AdmissionRegistry,
  userId: string,
  presetId: string,
  executionId: string,
  options?: AdmissionAcquireOptions,
): AdmissionResult {
  return registry.acquire(userId, presetId, executionId, options)
}

export function releaseAdmission(
  registry: AdmissionRegistry,
  userId: string,
  presetId: string,
  executionId: string,
): boolean {
  return registry.release(userId, presetId, executionId)
}

export function cancelAdmission(
  registry: AdmissionRegistry,
  userId: string,
  presetId: string,
  executionId: string,
): boolean {
  return registry.cancel(userId, presetId, executionId)
}

export function getAdmission(
  registry: AdmissionRegistry,
  userId: string,
  presetId: string,
  executionId: string,
): AdmissionLease | undefined {
  return registry.get(userId, presetId, executionId)
}

export function listActiveAdmissions(
  registry: AdmissionRegistry,
  userId: string,
  presetId?: string,
): readonly AdmissionLease[] {
  return registry.list(userId, presetId)
}
