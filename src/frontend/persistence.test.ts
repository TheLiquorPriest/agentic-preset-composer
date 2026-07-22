// @ts-ignore Bun provides the test module at runtime; the extension bundle excludes this file.
import { describe, expect, test } from "bun:test"
import type {
  ApcDomainIntent,
  ApcDomainResponse,
  ApcPresetEditorDraftAdapter,
  ApcPresetEditorDraftState,
} from "./persistence"
import { ApcPersistenceError, createApcPersistence } from "./persistence"
import type { BackendHydrationResponse, BackendViewResponseResponse } from "../protocol/messages"
import { PROTOCOL_VERSION } from "../protocol/messages"

const PRESET_ID = "550e8400-e29b-41d4-a716-446655440000"
const SECOND_PRESET_ID = "550e8400-e29b-41d4-a716-446655440010"
const CORRELATION_ID = "550e8400-e29b-41d4-a716-446655440001"

const EXECUTION_ID = "550e8400-e29b-41d4-a716-446655440002"
class FakeEditor implements ApcPresetEditorDraftAdapter {
  state: ApcPresetEditorDraftState = {
    presetId: PRESET_ID,
    metadata: { schemaVersion: 1, supportedModes: ["single"], activeMode: "single" },
  }
  updateCount = 0
  flushCount = 0
  failFlush = false
  failNextFlush = false
  flushFailureHook: (() => void) | null = null
  flushStartHook: (() => void) | null = null
  deferNotifications = false
  #flushBlocked = false
  #flushRelease: (() => void) | null = null
  #flushStartWaiters = new Set<() => void>()
  waitForFlushStart(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#flushStartWaiters.add(resolve)
    return promise
  }
  blockFlush(): void {
    this.#flushBlocked = true
  }
  releaseFlush(): void {
    this.#flushBlocked = false
    this.#flushRelease?.()
    this.#flushRelease = null
  }
  #listeners = new Set<(state: ApcPresetEditorDraftState) => void>()
  #deferredStates: ApcPresetEditorDraftState[] = []

  getState(): ApcPresetEditorDraftState {
    return this.state
  }

  onChange(listener: (state: ApcPresetEditorDraftState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  protected cloneValue<T>(value: T): T {
    return value
  }
  protected notify(): void {
    if (this.deferNotifications) {
      this.#deferredStates.push(this.state)
      return
    }
    this.emit()
  }
  emit(state: ApcPresetEditorDraftState = this.state): void {
    for (const listener of this.#listeners) listener(state)
  }
  releaseNotifications(latestOnly = false): void {
    const states = latestOnly ? this.#deferredStates.splice(-1) : this.#deferredStates.splice(0)
    for (const state of states) this.emit(state)
  }

  updateMetadata(mutator: (metadata: unknown) => unknown): void {
    this.updateCount += 1
    this.state = { ...this.state, metadata: this.cloneValue(mutator(this.cloneValue(this.state.metadata))) }
    this.notify()
  }

  async flush(): Promise<void> {
    this.flushCount += 1
    for (const resolve of this.#flushStartWaiters) resolve()
    this.#flushStartWaiters.clear()
    this.flushStartHook?.()
    if (this.failFlush || this.failNextFlush) {
      this.failNextFlush = false
      this.flushFailureHook?.()
      throw new Error("draft flush failed")
    }
    if (this.#flushBlocked) {
      const { promise, resolve } = Promise.withResolvers<void>()
      this.#flushRelease = resolve
      await promise
    }
    this.notify()
  }
}

class CloningEditor extends FakeEditor {
  protected override cloneValue<T>(value: T): T {
    return structuredClone(value)
  }

  override getState(): ApcPresetEditorDraftState {
    const state = super.getState()
    return { ...state, metadata: this.cloneValue(state.metadata) }
  }
}

class FakeTransport {
  sent: ApcDomainIntent[] = []
  #listeners = new Set<(message: ApcDomainResponse) => void>()

  send(message: ApcDomainIntent): void {
    this.sent.push(message)
  }

  onMessage(listener: (message: ApcDomainResponse) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  respond(message: ApcDomainResponse): void {
    for (const listener of this.#listeners) listener(message)
  }
}

function config(mode: string): Record<string, unknown> {
  return { schemaVersion: 1, supportedModes: [mode], activeMode: mode }
}

describe("APC frontend persistence", () => {
  test("hydrates from the scoped preset-editor draft and never sends a config backend intent", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const persistence = createApcPersistence({ editor, transport, correlationId: () => CORRELATION_ID })

    const result = await persistence.loadConfig(PRESET_ID)

    expect(result.raw).toBe(editor.state.metadata)
    expect(transport.sent).toEqual([])
    persistence.dispose()
  })
  test("requests safe persisted bindings and consents by preset", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const persistence = createApcPersistence({ editor, transport, correlationId: () => CORRELATION_ID })
    const pending = persistence.hydratePreset(PRESET_ID)
    const request = transport.sent[0]
    expect(request?.type).toBe("hydrate_preset")
    const response: BackendHydrationResponse = {
      version: PROTOCOL_VERSION,
      type: "hydration",
      correlationId: request?.correlationId ?? CORRELATION_ID,
      sequence: 1,
      payload: {
        presetId: PRESET_ID,
        bindings: [{ slotId: "slot", bound: true, descriptor: { label: "Primary", provider: "openai", model: "gpt-5" } }],
        consents: [{
          threadId: "550e8400-e29b-41d4-a716-446655440002",
          workspaceSource: "main-context",
          connectionSourceKey: "main",
          status: "approved",
          destination: { label: "Primary", provider: "openai", model: "gpt-5" },
          disclosure: { version: 1, summary: "Thread input", categories: ["thread", "workspace", "source", "destination", "provider", "model", "main-context", "input-bindings", "prior-stage-outputs"] },
        }],
      },
    }
    transport.respond(response)
    await expect(pending).resolves.toEqual(response.payload)
    persistence.dispose()
  })

  test("requests only the opaque delivered-response identity and resolves the backend acknowledgement", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const persistence = createApcPersistence({ editor, transport, correlationId: () => CORRELATION_ID })
    const pending = persistence.viewResponse(PRESET_ID, EXECUTION_ID)
    const request = transport.sent[0]
    expect(request).toMatchObject({
      type: "view_response",
      payload: { presetId: PRESET_ID, executionId: EXECUTION_ID },
    })
    expect(JSON.stringify(request)).not.toContain("content")
    const response: BackendViewResponseResponse = {
      version: PROTOCOL_VERSION,
      type: "view_response",
      correlationId: request?.correlationId ?? CORRELATION_ID,
      sequence: 1,
      payload: { presetId: PRESET_ID, executionId: EXECUTION_ID },
    }
    transport.respond(response)
    await expect(pending).resolves.toEqual(response.payload)
    persistence.dispose()
  })
  test("coalesces same-preset saves and resolves only after the flush barrier", async () => {
    const editor = new FakeEditor()
    const persistence = createApcPersistence({ editor })

    const first = persistence.saveConfig(PRESET_ID, config("single"))
    const second = persistence.saveConfig(PRESET_ID, config("sequential"))
    const [left, right] = await Promise.all([first, second])

    expect(left.raw).toEqual(config("sequential"))
    expect(right.raw).toEqual(config("sequential"))
    expect(editor.updateCount).toBe(1)
    expect(editor.flushCount).toBe(1)
    persistence.dispose()
  })

  test("marks the host flush publication owned for an ordinary cloned save", async () => {
    const editor = new CloningEditor()
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))

    await persistence.saveConfig(PRESET_ID, config("parallel"))

    expect(ownedEvents).toEqual([true, true])
    persistence.dispose()
  })

  test("keeps delayed save publication owned after the save settles", async () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))

    await persistence.saveConfig(PRESET_ID, config("parallel"))
    expect(ownedEvents).toEqual([])
    editor.releaseNotifications(true)

    expect(ownedEvents).toEqual([true])
    persistence.dispose()
  })

  test("keeps delayed rollback publication owned after a failed save settles", async () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    editor.failNextFlush = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))

    const pending = persistence.saveConfig(PRESET_ID, config("parallel"))
    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toEqual(config("single"))
    expect(ownedEvents).toEqual([])
    editor.releaseNotifications(true)

    expect(ownedEvents).toEqual([true])
    persistence.dispose()
  })

  test("keeps staged metadata owned through delayed host publication", async () => {
    const editor = new CloningEditor()
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const raw = config("parallel")

    persistence.stageConfig(PRESET_ID, raw)
    raw.activeMode = "external"
    expect(editor.state.metadata).toEqual(config("parallel"))
    expect(editor.state.metadata).not.toBe(raw)
    expect(editor.updateCount).toBe(1)
    expect(editor.flushCount).toBe(0)

    editor.blockFlush()
    const started = editor.waitForFlushStart()
    const publishing = editor.flush()
    await started
    expect(ownedEvents).toEqual([true])
    editor.releaseFlush()
    await publishing

    expect(ownedEvents).toEqual([true, true])
    editor.updateMetadata(() => config("external"))
    expect(ownedEvents[ownedEvents.length - 1]).toBe(false)
    persistence.dispose()
  })

  test("matches delayed owned callbacks in order and rejects a stale earlier callback", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const first = config("parallel")
    const second = config("sequential")

    persistence.stageConfig(PRESET_ID, first)
    persistence.stageConfig(PRESET_ID, second)
    editor.emit({ presetId: PRESET_ID, metadata: first })
    editor.emit({ presetId: PRESET_ID, metadata: second })
    editor.emit({ presetId: PRESET_ID, metadata: first })

    expect(ownedEvents).toEqual([true, true, false])
    persistence.dispose()
  })

  test("accepts a coalesced callback for the newest owned draft", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const first = config("single")
    const second = config("parallel")
    const newest = config("sequential")

    persistence.stageConfig(PRESET_ID, first)
    persistence.stageConfig(PRESET_ID, second)
    persistence.stageConfig(PRESET_ID, newest)
    editor.emit({ presetId: PRESET_ID, metadata: newest })
    editor.emit({ presetId: PRESET_ID, metadata: first })

    expect(ownedEvents).toEqual([true, false])
    persistence.dispose()
  })

  test("keeps delayed ownership expectations through interleaved foreign metadata", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const first = config("single")
    const second = config("parallel")

    persistence.stageConfig(PRESET_ID, first)
    persistence.stageConfig(PRESET_ID, second)
    editor.emit({ presetId: PRESET_ID, metadata: config("foreign") })
    editor.emit({ presetId: PRESET_ID, metadata: second })
    editor.emit({ presetId: PRESET_ID, metadata: first })

    expect(ownedEvents).toEqual([false, true, false])
    persistence.dispose()
  })

  test("preserves ownership for repeated equal metadata callbacks", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const repeated = config("parallel")

    persistence.stageConfig(PRESET_ID, repeated)
    persistence.stageConfig(PRESET_ID, repeated)
    editor.emit({ presetId: PRESET_ID, metadata: repeated })
    editor.emit({ presetId: PRESET_ID, metadata: repeated })

    expect(ownedEvents).toEqual([true, true])
    persistence.dispose()
  })

  test("clears ownership on a foreign current edit before an external revert", () => {
    const editor = new CloningEditor()
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const owned = config("parallel")

    persistence.stageConfig(PRESET_ID, owned)
    editor.updateMetadata(() => config("foreign"))
    editor.updateMetadata(() => owned)

    expect(ownedEvents).toEqual([true, false, false])
    persistence.dispose()
  })

  test("clears ownership when an authoritative regression matches an older expectation", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const first = config("parallel")
    const second = config("sequential")

    persistence.stageConfig(PRESET_ID, first)
    persistence.stageConfig(PRESET_ID, second)
    editor.state = { presetId: PRESET_ID, metadata: first }
    editor.emit(editor.state)
    editor.emit({ presetId: PRESET_ID, metadata: second })

    expect(ownedEvents).toEqual([false, false])
    persistence.dispose()
  })

  test("resets ownership when the observed preset changes", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const stale = config("parallel")
    const current = config("sequential")

    persistence.stageConfig(PRESET_ID, stale)
    editor.state = { presetId: SECOND_PRESET_ID, metadata: config("external") }
    editor.emit(editor.state)
    editor.emit({ presetId: PRESET_ID, metadata: stale })
    persistence.stageConfig(SECOND_PRESET_ID, current)
    editor.emit({ presetId: PRESET_ID, metadata: stale })
    editor.emit({ presetId: SECOND_PRESET_ID, metadata: current })

    expect(ownedEvents).toEqual([false, false, false, true])
    persistence.dispose()
  })

  test("drops expectations from an invalidated lifecycle on dispose", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const staged = config("parallel")

    persistence.stageConfig(PRESET_ID, staged)
    persistence.dispose()
    editor.emit({ presetId: PRESET_ID, metadata: staged })

    expect(persistence.disposed).toBe(true)
    expect(ownedEvents).toEqual([])
  })

  test("bounds delayed ownership expectations to the newest entries", () => {
    const editor = new CloningEditor()
    editor.deferNotifications = true
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const drafts = Array.from({ length: 80 }, (_, index) => config(`mode-${index}`))

    for (const draft of drafts) persistence.stageConfig(PRESET_ID, draft)
    editor.emit({ presetId: PRESET_ID, metadata: drafts[0] })
    editor.emit({ presetId: PRESET_ID, metadata: drafts[drafts.length - 1] })

    expect(ownedEvents).toEqual([false, true])
    persistence.dispose()
  })

  test("rejects staging before editor mutation when the preset does not match", () => {
    const editor = new CloningEditor()
    const persistence = createApcPersistence({ editor })
    let caught: unknown = null

    try {
      persistence.stageConfig("550e8400-e29b-41d4-a716-446655440099", config("parallel"))
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: "NO_PRESET" })
    expect(editor.updateCount).toBe(0)
    expect(editor.flushCount).toBe(0)
    persistence.dispose()
  })

  test("rolls back a failed cloned metadata flush when the draft is still owned", async () => {
    const editor = new CloningEditor()
    const persistence = createApcPersistence({ editor })
    editor.failNextFlush = true

    const pending = persistence.saveConfig(PRESET_ID, config("parallel"))

    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toEqual(config("single"))
    expect(editor.updateCount).toBe(2)
    expect(editor.flushCount).toBe(2)
    persistence.dispose()
  })

  test("does not roll back over a newer equal-valued stage", async () => {
    const editor = new CloningEditor()
    editor.failNextFlush = true
    const persistence = createApcPersistence({ editor })
    const staged = config("parallel")
    editor.flushFailureHook = () => {
      persistence.stageConfig(PRESET_ID, staged)
    }

    const pending = persistence.saveConfig(PRESET_ID, staged)

    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toEqual(staged)
    expect(editor.updateCount).toBe(2)
    expect(editor.flushCount).toBe(1)
    persistence.dispose()
  })

  test("marks editor changes external while rollback flush is pending", async () => {
    const editor = new CloningEditor()
    editor.failNextFlush = true
    editor.blockFlush()
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))
    const { promise: rollbackStarted, resolve: markRollbackStarted } = Promise.withResolvers<void>()
    editor.flushStartHook = () => {
      if (editor.flushCount === 2) markRollbackStarted()
    }

    const pending = persistence.saveConfig(PRESET_ID, config("parallel"))

    await rollbackStarted
    expect(editor.flushCount).toBe(2)
    editor.updateMetadata(() => config("external"))
    expect(ownedEvents[ownedEvents.length - 1]).toBe(false)
    editor.releaseFlush()
    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toEqual(config("external"))
    persistence.dispose()
  })

  test("uses a stable cloned failed batch value when the caller mutates raw during flush", async () => {
    const editor = new CloningEditor()
    const raw = config("parallel")
    editor.failNextFlush = true
    editor.flushFailureHook = () => {
      raw.activeMode = "external"
    }
    const persistence = createApcPersistence({ editor })

    const pending = persistence.saveConfig(PRESET_ID, raw)

    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toEqual(config("single"))
    expect(editor.updateCount).toBe(2)
    expect(editor.flushCount).toBe(2)
    persistence.dispose()
  })

  test("preserves a concurrent cloned metadata change after a failed flush", async () => {
    const editor = new CloningEditor()
    editor.failNextFlush = true
    editor.flushFailureHook = () => {
      editor.updateMetadata(() => config("external"))
    }
    const persistence = createApcPersistence({ editor })
    const ownedEvents: boolean[] = []
    persistence.subscribeDraft((event) => ownedEvents.push(event.owned))

    const pending = persistence.saveConfig(PRESET_ID, config("parallel"))

    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toEqual(config("external"))
    expect(editor.updateCount).toBe(2)
    expect(editor.flushCount).toBe(1)
    expect(ownedEvents[ownedEvents.length - 1]).toBe(false)
    persistence.dispose()
  })

  test("skips rollback when the current cloned metadata is undefined", async () => {
    const editor = new CloningEditor()
    editor.failNextFlush = true
    editor.flushFailureHook = () => {
      editor.state = { presetId: PRESET_ID, metadata: undefined }
    }
    const persistence = createApcPersistence({ editor })

    const pending = persistence.saveConfig(PRESET_ID, config("parallel"))

    await expect(pending).rejects.toThrow("draft flush failed")
    expect(editor.state.metadata).toBeUndefined()
    expect(editor.updateCount).toBe(1)
    expect(editor.flushCount).toBe(1)
    persistence.dispose()
  })


  test("sanitizes backend diagnostics before exposing request errors", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const persistence = createApcPersistence({ editor, transport, correlationId: () => CORRELATION_ID })
    const pending = persistence.bindSlot(PRESET_ID, "550e8400-e29b-41d4-a716-446655440002", "550e8400-e29b-41d4-a716-446655440003")
    const request = transport.sent[0]
    transport.respond({
      version: PROTOCOL_VERSION,
      type: "error",
      correlationId: request?.correlationId ?? CORRELATION_ID,
      payload: { code: "BACKEND_ERROR", messageKey: "error.backend", retryable: false },
    })
    await expect(pending).rejects.toMatchObject({ code: "BACKEND_ERROR", message: "APC backend request failed (BACKEND_ERROR)" })
    persistence.dispose()
  })

  test("rejects only the correlated request when backend decoding fails", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const persistence = createApcPersistence({ editor, transport, correlationId: () => CORRELATION_ID })
    const pending = persistence.bindSlot(PRESET_ID, "slot", "connection")
    persistence.handleInvalidMessage({ correlationId: transport.sent[0]?.correlationId, payload: "private backend data" })
    await expect(pending).rejects.toMatchObject({ code: "APC_BACKEND_PROTOCOL_ERROR" })
    persistence.handleInvalidMessage({ correlationId: "unrelated" })
    persistence.dispose()
  })
  test("domain responses remain typed and disposal rejects pending requests", async () => {
    const editor = new FakeEditor()
    const transport = new FakeTransport()
    const persistence = createApcPersistence({ editor, transport, correlationId: () => CORRELATION_ID })
    const pending = persistence.bindSlot(PRESET_ID, "550e8400-e29b-41d4-a716-446655440002", "550e8400-e29b-41d4-a716-446655440003")
    const request = transport.sent[0]
    expect(request?.type).toBe("bind_slot")
    persistence.dispose()
    await expect(pending).rejects.toBeInstanceOf(ApcPersistenceError)
  })
  test("flush rejects when disposed while the host flush is still pending", async () => {
    const editor = new FakeEditor()
    editor.blockFlush()
    const persistence = createApcPersistence({ editor })
    const started = editor.waitForFlushStart()
    const pending = persistence.flush()
    await started
    expect(editor.flushCount).toBe(1)
    persistence.dispose()
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    editor.releaseFlush()
  })
  test("public flush rejects while a save drain is blocked in host flush", async () => {
    const editor = new FakeEditor()
    editor.blockFlush()
    const persistence = createApcPersistence({ editor })
    const started = editor.waitForFlushStart()
    const save = persistence.saveConfig(PRESET_ID, config("parallel"))
    const flushing = persistence.flush()
    await started
    expect(editor.flushCount).toBe(1)
    persistence.dispose()
    await expect(save).rejects.toMatchObject({ code: "DISPOSED" })
    await expect(flushing).rejects.toMatchObject({ code: "DISPOSED" })
    editor.releaseFlush()
  })
})

