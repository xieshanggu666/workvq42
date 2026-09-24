import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions } from '@/utils/version'
import {
  GATE, ITEM_STATE, isGateOpen, isGatePendingImpact,
  buildImpact, canSubmitGate, canConfirmImpact, canDecideGate, canWithdrawGate,
  buildGateTimelineEntry
} from '@/utils/gate'
import { canEditDoc, GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { isDocRetired } from '@/utils/retirement'
import { useKbStore } from './kb'

// 知识变更影响评估与发布门禁 store：
// 编辑者提交版本（submitGate）→ 同事务冻结受影响的问答引用 / 缺口工单 / 共享链接：
//   文档锁定、问答引用暂停（isDocGateCitable）、有效共享链接挂起（shares.gateHoldAt）；
// 负责人确认影响（confirmImpact：pending_impact → pending_approval）→
// 管理员审批放行（decideGate 'release'）：同事务把待发布快照回写为新版本、解除锁定、
//   恢复问答引用（指向新版）、恢复共享链接并回写链接状态、逐项回写受影响项状态；
// 管理员驳回（'reject'）/ 回退（'rollback'）：版本不发布，解除锁定、恢复引用与共享链接。
// 提交人可在流转中撤回（withdrawGate，等同回退）。版本发布、引用、链接状态全程随结论同事务回写。
export const useGateStore = defineStore('gate', () => {
  const gates = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    gates.value = await db.changeGates.toArray()
  }

  const sorted = computed(() =>
    [...gates.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 某文档当前流转中的门禁（同一文档同时只允许一个）
  function openGateOfDoc(docId) {
    return gates.value.find((g) => g.docId === docId && isGateOpen(g)) || null
  }

  function gateById(id) {
    return gates.value.find((g) => g.id === id) || null
  }

  function gatesOfDoc(docId) {
    return gates.value
      .filter((g) => g.docId === docId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 待我确认影响（文档拥有者视角）/ 待我审批（管理员视角）
  function pendingImpactFor(userId, role, docs) {
    if (isGuestUser(userId)) return []
    const docById = Object.fromEntries((docs || []).map((d) => [d.id, d]))
    return sorted.value.filter((g) => {
      if (g.status !== GATE.PENDING_IMPACT) return false
      if (role === ROLE.ADMIN) return true
      return docById[g.docId]?.ownerId === userId
    })
  }

  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((g) => g.status === GATE.PENDING_APPROVAL)
  }

  // 侧栏角标：负责人待确认 + 管理员待审批
  function pendingCountFor(userId, role, docs) {
    return pendingImpactFor(userId, role, docs).length + pendingApprovalFor(role).length
  }

  // 编辑者提交版本并建立发布门禁。
  // patch：本次待发布的文档字段（title/body/categoryId/tagIds/visibility），审批放行时据此回写。
  // 同事务：建门禁单（冻结受影响项）→ 文档锁定（activeGateId）→ 有效共享链接挂起。
  // 返回 { status:'ok', gate } | 'guest' | 'denied' | 'missing' | 'duplicate' | 'review-locked' | 'retired'
  async function submitGate(docId, patch, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.docs, db.changeGates, db.reviews, db.shares, db.gapTickets, db.accessRequests,
      async () => {
        const doc = await db.docs.get(docId)
        if (!doc) { result = { status: 'missing' }; return }
        if (isGuestUser(userId)) { result = { status: 'guest' }; return }

        const activeRetirement = isDocRetired(doc)
        const pendingReview = await db.reviews
          .where('docId').equals(docId)
          .filter((r) => r.status === 'pending').first()
        const activeGate = await db.changeGates
          .where('docId').equals(docId)
          .filter((g) => isGateOpen(g)).first()
        if (activeRetirement) { result = { status: 'retired' }; return }
        if (pendingReview) { result = { status: 'review-locked' }; return }
        if (activeGate) { result = { status: 'duplicate', gate: activeGate }; return }

        // 限时协作授权（只读成员持协作授权可改正文，但不能发起内容发布门禁）
        let grant = null
        if (!isGuestUser(userId)) {
          const reqs = await db.accessRequests
            .where('docId').equals(docId)
            .filter((r) => r.applicantId === userId).toArray()
          grant = reqs.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB) || null
        }
        const canEdit = canEditDoc(doc, { userId, role, grant, now: new Date(nowIso) })
        if (!canSubmitGate(doc, { userId, role, canEdit, pendingReview, activeGate, retired: activeRetirement })) {
          result = { status: 'denied' }
          return
        }

        // 冻结受影响项（问答引用 / 缺口工单 / 共享链接）
        const gapTickets = await db.gapTickets.toArray()
        const shares = await db.shares.where('docId').equals(docId).toArray()
        const impact = buildImpact(doc, { gapTickets, shares, tagNames: kb.tags, now: new Date(nowIso) })

        const baseVersion = ensureVersions(doc, nowIso).length
        const heldShareIds = impact.share.map((it) => it.refId)
        const gate = {
          id: uid('gate'),
          docId,
          docTitle: doc.title,
          status: GATE.PENDING_IMPACT,
          submittedBy: userId,
          submittedAt: nowIso,
          baseVersion,
          // 待发布快照：放行时据此回写正文/可见性（先评估影响、后发布）
          snapshot: {
            title: patch.title,
            body: patch.body,
            categoryId: patch.categoryId,
            tagIds: patch.tagIds || [],
            visibility: patch.visibility
          },
          changeFields: fieldChangeList(doc, patch),
          ownerConfirmedBy: null,
          ownerConfirmedAt: null,
          ownerNote: '',
          decidedBy: null,
          decidedAt: null,
          decisionNote: '',
          releaseVersion: null,
          // 冻结的共享链接 id：结论时据此恢复并回写链接状态
          heldShareIds,
          impact,
          timeline: [buildGateTimelineEntry('submit', userId, note, nowIso)]
        }
        await db.changeGates.add(gate)

        // 文档锁定：正文保持旧版可见，问答引用暂停（闸门见 isDocGateCitable）
        await db.docs.update(docId, { activeGateId: gate.id })

        // 共享链接挂起：有效链接标记 gateHoldAt（不撤销、记录保留），放行/驳回/回退后恢复
        for (const sid of heldShareIds) {
          const s = await db.shares.get(sid)
          if (!s || s.revokedAt || s.gateHoldAt) continue
          if (s.expiresAt && new Date(s.expiresAt) <= new Date(nowIso)) continue
          await db.shares.update(s.id, { gateHoldAt: nowIso, gateHoldId: gate.id })
        }

        result = { status: 'ok', gate }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 负责人（文档拥有者 / 管理员）确认影响：pending_impact → pending_approval。
  // 返回 { status:'ok', gate } | 'guest' | 'denied' | 'missing' | 'changed'
  async function confirmImpact(gateId, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.changeGates, db.docs, async () => {
      const gate = await db.changeGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!isGatePendingImpact(gate)) { result = { status: 'changed', gate }; return }
      if (!canConfirmImpact(gate, doc, userId, role)) { result = { status: 'denied' }; return }

      const updated = {
        ...gate,
        status: GATE.PENDING_APPROVAL,
        ownerConfirmedBy: userId,
        ownerConfirmedAt: nowIso,
        ownerNote: String(note || '').trim(),
        timeline: [...(gate.timeline || []), buildGateTimelineEntry('impact-confirm', userId, note, nowIso)]
      }
      await db.changeGates.put(updated)
      result = { status: 'ok', gate: updated }
    })

    await reload()
    return result
  }

  // 管理员审批：
  // - 'release' 放行：回写待发布快照为新版本、解除锁定、恢复问答引用（指向新版）、
  //   恢复共享链接并回写状态、逐项回写受影响项状态；
  // - 'reject' 驳回 / 'rollback' 回退：版本不发布，解除锁定、恢复引用与共享链接。
  // 返回 { status:'ok', gate, released } | 各类错误码
  async function decideGate(gateId, decision, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const decideNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.docs, db.changeGates, db.shares, db.gapTickets, async () => {
        const gate = await db.changeGates.get(gateId)
        if (!gate) { result = { status: 'missing' }; return }
        if (!isGateOpen(gate)) { result = { status: 'changed', gate }; return }
        if (!canDecideGate(gate, userId, currentUser?.role)) {
          result = isGuestUser(userId) ? { status: 'guest' } : { status: 'denied' }
          return
        }
        const doc = await db.docs.get(gate.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }

        const release = decision === 'release'
        const finalStatus = release ? GATE.RELEASED : decision === 'rollback' ? GATE.ROLLED_BACK : GATE.REJECTED
        const itemTarget = release ? ITEM_STATE.RELEASED : decision === 'rollback' ? ITEM_STATE.ROLLED_BACK : ITEM_STATE.REJECTED
        const action = release ? 'release' : decision === 'rollback' ? 'rollback' : 'reject'

        // 共享链接：恢复本次挂起的链接（清除挂起标记），并逐项回写受影响项状态。
        // 门禁期间被人工撤销 / 已过期的链接不强行恢复，仅按当前实际状态回写。
        const restoredShareIds = []
        for (const sid of gate.heldShareIds || []) {
          const s = await db.shares.get(sid)
          if (!s) continue
          if (s.gateHoldId === gate.id) {
            const expired = s.expiresAt && new Date(s.expiresAt) <= new Date(nowIso)
            if (!s.revokedAt && !expired) {
              await db.shares.update(s.id, { gateHoldAt: null, gateHoldId: null })
              restoredShareIds.push(s.id)
            } else {
              // 期间已撤销/过期：清除挂起标记，链接保持其撤销/过期终态
              await db.shares.update(s.id, { gateHoldAt: null, gateHoldId: null })
            }
          }
        }

        // 逐项回写受影响项状态（冻结快照旧值随 impact 保留，仅更新 state）
        const impact = gate.impact || { qa: [], gap: [], share: [], all: [], counts: {} }
        const stampItems = (list) => list.map((it) => ({
          ...it,
          state: itemTarget,
          decidedAt: nowIso
        }))
        const qa = stampItems(impact.qa || [])
        const gapItems = stampItems(impact.gap || [])
        const shareItems = stampItems(impact.share || [])
        const newImpact = {
          ...impact,
          qa, gap: gapItems, share: shareItems,
          all: [...qa, ...gapItems, ...shareItems]
        }

        let releaseVersion = null
        if (release) {
          // 放行：回写快照为新版本（版本发布状态回写），问答引用随检索动态指向新版
          const versions = ensureVersions(doc, nowIso)
          const nextVersion = versions.length + 1
          const entry = {
            version: nextVersion,
            savedAt: nowIso,
            savedBy: gate.submittedBy,
            note: '发布门禁放行后发布' + (decideNote ? '：' + decideNote : ''),
            reviewStatus: 'approved',
            gate: { gateId: gate.id, status: GATE.RELEASED, decidedBy: userId },
            decidedBy: userId,
            snapshot: { ...gate.snapshot }
          }
          releaseVersion = nextVersion
          await db.docs.put({
            ...doc,
            ...gate.snapshot,
            activeGateId: null,
            updatedAt: nowIso,
            lastGate: { gateId: gate.id, status: GATE.RELEASED, by: userId, at: nowIso, note: decideNote, version: nextVersion },
            versions: [...versions, entry]
          })
        } else {
          // 驳回 / 回退：版本不发布，正文保持旧版，仅解除锁定
          await db.docs.update(doc.id, {
            activeGateId: null,
            lastGate: { gateId: gate.id, status: finalStatus, by: userId, at: nowIso, note: decideNote }
          })
        }

        const decided = {
          ...gate,
          status: finalStatus,
          decidedBy: userId,
          decidedAt: nowIso,
          decisionNote: decideNote,
          releaseVersion,
          impact: newImpact,
          restoredShareIds,
          timeline: [
            ...(gate.timeline || []),
            buildGateTimelineEntry(action, userId, decideNote, nowIso)
          ]
        }
        await db.changeGates.put(decided)
        result = { status: 'ok', gate: decided, released: release, releaseVersion }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 提交人撤门禁（流转中）：等同回退——版本不发布，解除锁定、恢复引用与共享链接。
  async function withdrawGate(gateId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction('rw', db.changeGates, db.docs, db.shares, async () => {
      const gate = await db.changeGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canWithdrawGate(gate, userId)) { result = { status: 'denied' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }

      const restoredShareIds = []
      for (const sid of gate.heldShareIds || []) {
        const s = await db.shares.get(sid)
        if (!s) continue
        if (s.gateHoldId === gate.id && !s.revokedAt &&
          !(s.expiresAt && new Date(s.expiresAt) <= new Date(nowIso))) {
          await db.shares.update(s.id, { gateHoldAt: null, gateHoldId: null })
          restoredShareIds.push(s.id)
        } else if (s.gateHoldId === gate.id) {
          await db.shares.update(s.id, { gateHoldAt: null, gateHoldId: null })
        }
      }

      const impact = gate.impact || { qa: [], gap: [], share: [], all: [], counts: {} }
      const stamp = (list) => list.map((it) => ({ ...it, state: ITEM_STATE.ROLLED_BACK, decidedAt: nowIso }))
      const qa = stamp(impact.qa || [])
      const gapItems = stamp(impact.gap || [])
      const shareItems = stamp(impact.share || [])

      await db.docs.update(doc.id, {
        activeGateId: null,
        lastGate: { gateId: gate.id, status: GATE.ROLLED_BACK, by: userId, at: nowIso, note: '提交人撤回', withdrawn: true }
      })
      const withdrawn = {
        ...gate,
        status: GATE.ROLLED_BACK,
        decidedBy: userId,
        decidedAt: nowIso,
        decisionNote: '提交人撤回',
        withdrawn: true,
        restoredShareIds,
        impact: { ...impact, qa, gap: gapItems, share: shareItems, all: [...qa, ...gapItems, ...shareItems] },
        timeline: [...(gate.timeline || []), buildGateTimelineEntry('withdraw', userId, '', nowIso)]
      }
      await db.changeGates.put(withdrawn)
      result = { status: 'ok', gate: withdrawn }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 删除文档时连带清理门禁单并恢复其挂起的共享链接
  async function deleteGatesOfDoc(docId) {
    const open = await db.changeGates.where('docId').equals(docId).toArray()
    const nowIso = new Date().toISOString()
    for (const g of open) {
      if (!isGateOpen(g)) continue
      for (const sid of g.heldShareIds || []) {
        const s = await db.shares.get(sid)
        if (s && s.gateHoldId === g.id) await db.shares.update(s.id, { gateHoldAt: null, gateHoldId: null })
      }
    }
    await db.changeGates.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  return {
    gates, loaded, loadAll, reload, sorted,
    openGateOfDoc, gateById, gatesOfDoc,
    pendingImpactFor, pendingApprovalFor, pendingCountFor,
    submitGate, confirmImpact, decideGate, withdrawGate, deleteGatesOfDoc
  }
})

// 待发布字段相对当前文档的变化清单（供门禁单展示「放行后将变更哪些字段」）
function fieldChangeList(doc, patch) {
  const out = []
  if ((patch.title || '') !== (doc.title || '')) out.push('title')
  if ((patch.body || '') !== (doc.body || '')) out.push('body')
  if ((patch.categoryId || null) !== (doc.categoryId || null)) out.push('categoryId')
  if (JSON.stringify(patch.tagIds || []) !== JSON.stringify(doc.tagIds || [])) out.push('tagIds')
  if ((patch.visibility || 'public') !== (doc.visibility || 'public')) out.push('visibility')
  return out
}
