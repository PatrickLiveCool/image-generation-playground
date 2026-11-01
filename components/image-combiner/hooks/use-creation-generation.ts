"use client"

import { useCallback, useEffect, useRef } from "react"
import { useAccountVisible } from "@/components/account/account-visibility"
import type { PublicModelCatalog } from "@/lib/provider-configuration-types"
import { buildCreationRequest } from "@/lib/creation-request"
import { PrivateWorkspaceError, requestPrivateRun } from "@/lib/private-workspace-client"
import type { PrivateRun } from "@/lib/private-workspace-types"
import type { CreativeWorkspaceController } from "./use-creative-workspace"

interface RunningRequest { id: string; controller: AbortController; submitted?: boolean; timer?: ReturnType<typeof setInterval> }
const ongoing = (run: PrivateRun) => ["preparing", "generating", "saving"].includes(run.status)
function waitForPoll(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, 2000)
    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) done()
  })
}

/** Each request captures a creation and draft revision before any asynchronous work. */
export function useCreationGeneration(workspace: CreativeWorkspaceController, catalog: PublicModelCatalog, onToast: (message: string, type?: "success" | "error") => void) {
  const accountVisible = useAccountVisible()
  const visibleRef = useRef(accountVisible)
  visibleRef.current = accountVisible
  const requests = useRef(new Map<string, RunningRequest>())
  const observed = useRef(new Set<string>())
  const mounted = useRef(true)
  const { getCreation, startGeneration, updateGeneration, failGeneration, ensureRemoteCreation, applyRun, markUnknown } = workspace
  useEffect(() => {
    if (!accountVisible) {
      for (const [creationId, request] of requests.current) {
        // AccountGate briefly hides the same mounted editor while checking its
        // session. Aborting a submitted POST also cancels its model request.
        if (request.submitted) continue
        clearInterval(request.timer); request.controller.abort(); observed.current.delete(request.id)
        requests.current.delete(creationId)
      }
    }
  }, [accountVisible])
  useEffect(() => {
    mounted.current = true
    const running = requests.current
    const beforeUnload = (event: BeforeUnloadEvent) => { if (running.size) { event.preventDefault(); event.returnValue = "" } }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      mounted.current = false
      window.removeEventListener("beforeunload", beforeUnload)
      for (const request of running.values()) { clearInterval(request.timer); request.controller.abort() }
      running.clear()
    }
  }, [])

  const poll = useCallback(async (creationId: string, id: string, controller: AbortController, initial?: PrivateRun) => {
    let run = initial
    for (let attempt = 0; attempt < 5; attempt++) {
      if (controller.signal.aborted || !mounted.current) return
      if (run) {
        applyRun(run)
        if (!ongoing(run)) return
        await waitForPoll(controller.signal)
      }
      if (controller.signal.aborted || !mounted.current) return
      run = await requestPrivateRun(id, { signal: controller.signal })
      if (run.creationId !== creationId) throw new PrivateWorkspaceError("任务归属未能确认，请刷新创作。")
    }
    if (!controller.signal.aborted && mounted.current && run) {
      applyRun(run)
      if (ongoing(run)) markUnknown(creationId, id, "任务仍在处理，已停止自动查询；请稍后查看状态，勿重复提交。")
    }
  }, [applyRun, markUnknown])

  const checkStatus = useCallback(async (creationId: string, id: string, repair = false) => {
    if (!visibleRef.current || requests.current.has(creationId)) return
    const controller = new AbortController()
    requests.current.set(creationId, { id, controller })
    observed.current.add(id)
    try {
      const run = await requestPrivateRun(id, { signal: controller.signal, repair })
      if (run.creationId !== creationId) throw new PrivateWorkspaceError("任务归属未能确认，请刷新创作。")
      await poll(creationId, id, controller, run)
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return
      const message = error instanceof PrivateWorkspaceError && error.status === 404
        ? "未找到本次任务。输入已保留，请刷新创作核对；需要重新生成时请明确提交。"
        : error instanceof Error ? error.message : "任务状态尚未确认，请稍后查看状态。"
      markUnknown(creationId, id, message)
      onToast(message, "error")
    } finally { if (requests.current.get(creationId)?.controller === controller) requests.current.delete(creationId) }
  }, [markUnknown, onToast, poll])

  useEffect(() => {
    if (!accountVisible) return
    for (const creation of workspace.creations) {
      const pending = creation.versions.find(run => run.status === "loading" && run.runStatus)
      if (pending && !observed.current.has(pending.id) && !requests.current.has(creation.id)) void checkStatus(creation.id, pending.id)
    }
  }, [workspace.creations, checkStatus, accountVisible])

  const generate = useCallback(async (creationId: string) => {
    if (!visibleRef.current || requests.current.has(creationId)) return
    const creation = getCreation(creationId)
    if (!creation) return
    let prepared: ReturnType<typeof buildCreationRequest>
    try { prepared = buildCreationRequest({ creation, catalog }) }
    catch (error) { onToast(error instanceof Error ? error.message : "请检查本轮输入。", "error"); return }
    const { formData, generation } = prepared
    const controller = new AbortController()
    const request: RunningRequest = { id: generation.id, controller }
    requests.current.set(creationId, request)
    observed.current.add(generation.id)
    try {
      await ensureRemoteCreation(creationId, generation.prompt)
      if (controller.signal.aborted || !mounted.current || !startGeneration(creationId, generation)) return
      request.submitted = true
      const startedAt = Date.now()
      request.timer = setInterval(() => updateGeneration(creationId, generation.id, {
        progress: Math.min(92, 5 + 87 * (1 - Math.exp(-(Date.now() - startedAt) / 70_000))), phase: "generating",
      }), 1000)
      const run = await requestPrivateRun(generation.id, { formData, signal: controller.signal })
      if (run.creationId !== creationId) throw new PrivateWorkspaceError("任务归属未能确认，请刷新创作。")
      await poll(creationId, generation.id, controller, run)
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return
      const message = error instanceof Error ? error.message : "连接中断，生成结果尚未确认。请查看状态，勿重复提交。"
      if (request.submitted) {
        if (error instanceof PrivateWorkspaceError && error.status >= 400 && error.status < 500) failGeneration(creationId, generation.id, message)
        else markUnknown(creationId, generation.id, message)
      }
      onToast(message, "error")
    } finally {
      clearInterval(request.timer)
      if (requests.current.get(creationId)?.controller === controller) requests.current.delete(creationId)
    }
  }, [catalog, getCreation, ensureRemoteCreation, startGeneration, updateGeneration, failGeneration, markUnknown, onToast, poll])

  const cancel = useCallback((creationId: string, id: string) => {
    const request = requests.current.get(creationId)
    if (request?.id === id) {
      request.controller.abort(); clearInterval(request.timer); requests.current.delete(creationId)
    }
    markUnknown(creationId, id, "已停止等待，任务可能仍在处理。输入已保留，请查看状态；不会自动重新生成。")
  }, [markUnknown])
  return { generate, cancel, checkStatus }
}
