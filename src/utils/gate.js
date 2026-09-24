// 知识变更影响评估与发布门禁：状态常量、影响面计算、引用/链接闸门、权限判定与留痕工具
// （均为纯函数，便于复用与测试）
// 流程：编辑者提交版本（snapshot 待发布）→ 建立门禁并冻结受影响的问答引用 / 缺口工单 / 共享链接，
//   提交即暂停问答引用、挂起共享链接、锁定正文（pending_impact，待负责人确认影响）→
//   负责人确认影响（pending_approval，待管理员审批）→
//   管理员审批放行（released：回写版本发布、恢复问答引用、恢复共享链接并回写链接状态）或
//   回退（rolled_back：版本不发布，恢复问答引用与共享链接）；
//   负责人确认前后管理员均可驳回（rejected：版本不发布，恢复引用与链接）。
// 全程在门禁单 timeline 留痕，版本发布 / 引用 / 链接状态随结论同事务回写。
import { ROLE, isGuestUser } from './permission'

// 门禁单状态
export const GATE = {
  PENDING_IMPACT: 'pending_impact', // 待负责人确认影响：已提交，问答引用暂停、共享链接挂起、正文锁定
  PENDING_APPROVAL: 'pending_approval', // 待管理员审批：负责人已确认影响
  RELEASED: 'released', // 已放行：版本发布，问答引用与共享链接恢复
  REJECTED: 'rejected', // 已驳回：管理员驳回，版本不发布，引用/链接恢复
  ROLLED_BACK: 'rolled_back' // 已回退：管理员回退，版本不发布，引用/链接恢复
}

// 受影响项类型
export const GATE_IMPACT = {
  QA: 'qa', // 问答引用（引用本知识库内容的问答）
  GAP: 'gap', // 缺口工单（关联本内容的未解决补写需求）
  SHARE: 'share' // 共享链接
}

// 受影响项状态（逐项随门禁结论回写）
export const ITEM_STATE = {
  AFFECTED: 'affected', // 受影响：门禁流转中，引用暂停 / 链接挂起
  RELEASED: 'released', // 已放行：随版本发布恢复（问答引用恢复指向新版 / 链接恢复）
  REJECTED: 'rejected', // 已驳回：门禁驳回，恢复原状
  ROLLED_BACK: 'rolled_back' // 已回退：门禁回退，恢复原状
}

export function gateStatusLabel(status) {
  return {
    pending_impact: '待负责人确认影响',
    pending_approval: '待管理员审批',
    released: '已放行发布',
    rejected: '已驳回',
    rolled_back: '已回退'
  }[status] || status
}

export function gateStatusCls(status) {
  return {
    pending_impact: 'st-impact',
    pending_approval: 'st-approval',
    released: 'st-ok',
    rejected: 'st-no',
    rolled_back: 'st-back'
  }[status] || ''
}

export function gateItemStateLabel(state) {
  return {
    affected: '受影响 · 已暂停',
    released: '已恢复',
    rejected: '已恢复（驳回）',
    rolled_back: '已恢复（回退）'
  }[state] || state
}

export function gateImpactTypeLabel(type) {
  return { qa: '问答引用', gap: '缺口工单', share: '共享链接' }[type] || type
}

// 门禁单是否仍在流转中（未给出最终结论）
export function isGateOpen(gate) {
  return !!gate && (gate.status === GATE.PENDING_IMPACT || gate.status === GATE.PENDING_APPROVAL)
}

// 门禁是否待负责人确认影响
export function isGatePendingImpact(gate) {
  return !!gate && gate.status === GATE.PENDING_IMPACT
}

// 门禁是否待管理员审批（负责人已确认）
export function isGatePendingApproval(gate) {
  return !!gate && gate.status === GATE.PENDING_APPROVAL
}

// 门禁是否已放行（版本已发布，引用指向新版）
export function isGateReleased(gate) {
  return !!gate && gate.status === GATE.RELEASED
}

// ---- 文档级闸门 ----

// 文档是否有流转中的发布门禁（提交即锁定正文、暂停问答引用、挂起共享链接）
export function isDocGateOpen(doc, activeGate) {
  if (activeGate) return isGateOpen(activeGate)
  return !!doc?.activeGateId
}

// 文档是否可被问答引用：存在流转中门禁时一律暂停（放行后恢复引用并指向新版本）。
// 与知识保鲜 / 知识退役闸门在问答页取交集。
export function isDocGateCitable(doc, activeGate) {
  return !!doc && !isDocGateOpen(doc, activeGate)
}

// ---- 影响面计算（提交时冻结快照，结论时据此逐项回写）----

// 问答引用影响：以缺口工单中「引用本知识库内容的问答」为来源——
// 每条工单的问题来自问答页未命中/未解决的提问，按问答页同源的关键词匹配（extractKeywords 打分），
// 其关键词命中本文档标题/标签/正文即视为该问答引用了本文档内容，本次变更会影响这些问答的答案。
// 与问答页 scoreDoc 同一判定口径（命中即 score>0），保证提交时冻结与问答页实际引用一致。
// 返回 [{ id, type:'qa', refId, title, keywords:[], state }]
function qaKeywords(question) {
  // 与 utils/qa.extractKeywords 同源：按标点/空白切词并剔除弱词
  const weak = new Set(['如何', '怎么', '什么', '哪些', '请问', '请', '一下', '了', '的', '里', '中', '有'])
  return String(question || '')
    .replace(/[？?！!。，,、；;：:]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !weak.has(w))
}

export function buildQaImpactItems(doc, gapTickets, tagNames = []) {
  const bodyText = String(doc?.body || '').toLowerCase()
  const title = String(doc?.title || '').toLowerCase()
  const tagText = (doc?.tagIds || [])
    .map((id) => (tagNames.find((t) => t.id === id)?.name || '').toLowerCase())
    .join(' ')
  const items = []
  const seen = new Set()
  for (const t of gapTickets || []) {
    const question = String(t.question || '')
    if (!question.trim()) continue
    const qLower = question.toLowerCase()
    const kws = qaKeywords(question)
    // 中文标题无空格切词：问题直接包含完整标题，或标题中较长的中文片段出现在问题中，即视为引用本文档
    const titleHit = !!title && (qLower.includes(title) || titleFuzzyHit(qLower, title))
    // 问答引用判定：问题命中标题，或任一切分关键词命中标题 / 标签 / 正文（与问答检索 score>0 口径一致）
    const hit = titleHit || kws.some((kwRaw) => {
      const kw = kwRaw.toLowerCase()
      return title.includes(kw) || (tagText && tagText.includes(kw)) || bodyText.includes(kw)
    })
    if (!hit) continue
    const key = 'qa:' + t.id
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      id: 'gi-qa-' + t.id,
      type: GATE_IMPACT.QA,
      refId: t.id,
      title: question,
      keywords: kws,
      state: ITEM_STATE.AFFECTED
    })
  }
  return items
}

// 中文标题的模糊命中：取标题中长度 ≥3 的连续中文/字母数字片段，任一片段出现在问题中即命中。
// 例如标题「鉴权与权限模型」、问题「鉴权与权限模型里有哪些角色？」直接包含；
// 标题「入职指引」、问题「入职指引第一天做什么？」由完整片段命中。
function titleFuzzyHit(qLower, title) {
  const segments = String(title).match(/[一-龥a-z0-9]{3,}/gi) || []
  return segments.some((seg) => seg.length >= 3 && qLower.includes(seg.toLowerCase()))
}

// 缺口工单影响：未解决（open / claimed / in_review）且与本文档关联或其问题引用本文档的工单。
// 已解决工单的答案来源已固定，不列入（版本发布后检索动态命中新版，无需联动）。
// 返回 [{ id, type:'gap', refId, title, ticketStatus, state }]
export function buildGapImpactItems(doc, gapTickets, qaItems) {
  const openStatus = new Set(['open', 'claimed', 'in_review'])
  const qaRefs = new Set((qaItems || []).map((x) => x.refId))
  const items = []
  const seen = new Set()
  const push = (t, reason) => {
    const key = 'gap:' + t.id
    if (seen.has(key)) return
    seen.add(key)
    items.push({
      id: 'gi-gap-' + t.id,
      type: GATE_IMPACT.GAP,
      refId: t.id,
      title: t.question || '',
      ticketStatus: t.status,
      reason,
      state: ITEM_STATE.AFFECTED
    })
  }
  for (const t of gapTickets || []) {
    if (!openStatus.has(t.status)) continue
    if (t.docId === doc.id) push(t, '关联文档')
    else if (qaRefs.has(t.id)) push(t, '问答引用本文档')
  }
  return items
}

// 共享链接影响：本文档当前「有效」（未撤销、未过期）的共享链接——门禁期间挂起（暂停访问/编辑），
// 放行/驳回/回退后恢复。已撤销 / 已过期链接不列入。
// 返回 [{ id, type:'share', refId, title, permission, state }]
export function buildShareImpactItems(doc, shares, now = new Date()) {
  const items = []
  const nowMs = new Date(now).getTime()
  for (const s of shares || []) {
    if (s.docId !== doc.id) continue
    if (s.revokedAt) continue
    if (s.expiresAt && new Date(s.expiresAt).getTime() <= nowMs) continue
    items.push({
      id: 'gi-share-' + s.id,
      type: GATE_IMPACT.SHARE,
      refId: s.id,
      title: s.token,
      permission: s.permission,
      state: ITEM_STATE.AFFECTED
    })
  }
  return items
}

// 汇总受影响项（提交时一次冻结）
export function buildImpact(doc, ctx = {}) {
  const qa = buildQaImpactItems(doc, ctx.gapTickets || [], ctx.tagNames || [])
  const gap = buildGapImpactItems(doc, ctx.gapTickets || [], qa)
  const share = buildShareImpactItems(doc, ctx.shares || [], ctx.now || new Date())
  return {
    qa,
    gap,
    share,
    all: [...qa, ...gap, ...share],
    counts: { qa: qa.length, gap: gap.length, share: share.length, total: qa.length + gap.length + share.length }
  }
}

// 按状态重算受影响项分组（结论回写后供页面展示）
export function impactGroups(impact) {
  const all = impact?.all || []
  return {
    qa: all.filter((x) => x.type === GATE_IMPACT.QA),
    gap: all.filter((x) => x.type === GATE_IMPACT.GAP),
    share: all.filter((x) => x.type === GATE_IMPACT.SHARE)
  }
}

// ---- 权限判定 ----

// 提交门禁（编辑者提交版本）：登录、具备内容治理角色，且对文档有正文写入资格，
// 文档无流转中评审单 / 门禁、未退役。ctx: { userId, role, canEdit, pendingReview, activeGate, retired }
export function canSubmitGate(doc, ctx = {}) {
  if (!doc || isGuestUser(ctx.userId)) return false
  if (ctx.role !== ROLE.ADMIN && ctx.role !== ROLE.EDITOR) return false
  if (ctx.retired) return false
  if (ctx.pendingReview) return false
  if (isDocGateOpen(doc, ctx.activeGate)) return false
  return ctx.canEdit === true
}

// 负责人确认影响：文档拥有者或管理员，且门禁处于待确认影响阶段
export function canConfirmImpact(gate, doc, userId, role) {
  if (!isGatePendingImpact(gate) || isGuestUser(userId)) return false
  if (role === ROLE.ADMIN) return true
  return !!doc && doc.ownerId === userId
}

// 管理员审批（放行 / 驳回 / 回退）：仅管理员，且门禁仍在流转中
export function canDecideGate(gate, userId, role) {
  return isGateOpen(gate) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 提交人撤门禁：提交人本人，且仍在流转中（撤回等同回退，恢复引用/链接）
export function canWithdrawGate(gate, userId) {
  return isGateOpen(gate) && !isGuestUser(userId) && gate.submittedBy === userId
}

// ---- 留痕 ----

export function buildGateTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function gateTimelineLabel(action) {
  return {
    submit: '提交版本 · 建立发布门禁',
    'impact-confirm': '负责人确认影响',
    release: '管理员审批放行 · 版本发布',
    reject: '管理员驳回 · 版本不发布',
    rollback: '管理员回退 · 版本不发布',
    withdraw: '提交人撤门禁 · 恢复引用/链接'
  }[action] || action
}

// 版本记录上的门禁标记
export function gateVersionBadge(v) {
  if (!v?.gate) return null
  if (v.gate.status === GATE.RELEASED) return { text: '门禁放行 v' + v.version, cls: 'gate-ok' }
  return { text: '门禁发布', cls: 'gate' }
}
