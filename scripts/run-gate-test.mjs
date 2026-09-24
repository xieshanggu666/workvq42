// 知识变更影响评估与发布门禁：端到端冒烟测试（fake-indexeddb + 真实 store）
// 运行：npm run test:gate（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useGateStore } from '@/stores/gate'
import { useGapStore } from '@/stores/gap'
import { useShareStore } from '@/stores/share'
import { GATE, ITEM_STATE, isDocGateOpen, isDocGateCitable, buildImpact } from '@/utils/gate'
import { shareStatus } from '@/utils/share'
import { PUBLISH } from '@/utils/review'
import { isDocCitable as freshCitable } from '@/utils/freshness'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const gate = useGateStore(pinia)
const gap = useGapStore(pinia)
const share = useShareStore(pinia)

const editor = { id: 'u-chen', role: 'editor', name: '陈思涵' }
const otherEditor = { id: 'u-ziwei', role: 'editor', name: '王子薇' }
const viewer = { id: 'u-xiaoye', role: 'viewer', name: '高晓叶' }
const admin = { id: 'u-admin', role: 'admin', name: '林致远' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

async function mkDoc(over = {}) {
  const id = 'doc-' + Math.random().toString(36).slice(2, 8)
  const now = new Date().toISOString()
  const doc = {
    id,
    title: over.title || '鉴权与权限模型',
    body: over.body || '<p>Token 与权限点校验，角色 admin/editor/viewer。</p>',
    categoryId: 'c-dev', tagIds: ['t-api'], visibility: 'team',
    ownerId: over.ownerId || 'u-admin',
    editors: over.editors || ['u-admin', 'u-chen'],
    publishState: PUBLISH.PUBLISHED, activeGateId: null,
    createdAt: now, updatedAt: now,
    versions: [{ version: 1, savedAt: now, savedBy: over.ownerId || 'u-admin', note: '初始', snapshot: { title: over.title || '鉴权与权限模型', body: over.body || '<p>Token 与权限点校验，角色 admin/editor/viewer。</p>', categoryId: 'c-dev', tagIds: ['t-api'], visibility: 'team' } }]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}
const patch = (doc, body) => ({ title: doc.title, body: body || doc.body + '<p>新增：发布门禁期间共享链接挂起。</p>', categoryId: doc.categoryId, tagIds: doc.tagIds, visibility: doc.visibility })

// ---------- 1. 提交门禁：冻结影响项、暂停引用、挂起共享链接、锁定正文 ----------
console.log('\n[1] 提交门禁：问答引用暂停 + 共享链接挂起 + 正文锁定')
const doc1 = await mkDoc()
// 一张会引用本文档的缺口工单（问题关键词命中标题）
const t = await gap.createTicket({ question: '鉴权与权限模型里有哪些角色？', detail: '' }, viewer)
// 一条有效共享链接（view）与一条可编辑链接
const sv = await share.createShare(doc1.id, 'view', 0, editor)
const se = await share.createShare(doc1.id, 'edit', 0, editor)
assert(sv.status === 'ok' && se.status === 'ok', '准备了两条有效共享链接')

let r = await gate.submitGate(doc1.id, patch(doc1), '补充门禁说明', editor)
assert(r.status === 'ok', '编辑者提交门禁成功')
const g1 = r.gate
assert(g1.status === GATE.PENDING_IMPACT, '门禁进入待负责人确认影响')
assert(g1.impact.counts.qa >= 1, '冻结了问答引用（缺口工单问题命中本文档）')
assert(g1.impact.counts.share === 2, '冻结了 2 条有效共享链接')
assert(g1.impact.qa.every((x) => x.state === ITEM_STATE.AFFECTED), '受影响问答引用标记为 affected')

let d1 = await db.docs.get(doc1.id)
assert(isDocGateOpen(d1, await db.changeGates.get(g1.id)), '文档处于门禁开放态')
assert(!isDocGateCitable(d1, await db.changeGates.get(g1.id)), '问答引用已暂停')
const heldSv = await db.shares.get(sv.share.id)
const heldSe = await db.shares.get(se.share.id)
assert(shareStatus(heldSv) === 'suspended' && !!heldSv.gateHoldAt, '只读共享链接已挂起')
assert(shareStatus(heldSe) === 'suspended', '可编辑共享链接已挂起')

// 正文锁定：编辑者/他人不能直接保存
const saveRes = await kb.updateDoc(doc1.id, { body: '<p>强行保存</p>' }, otherEditor, '强存', {})
assert(saveRes.status === 'access-denied' || saveRes.status === 'gate-locked', '非关联编辑者被拒绝')
const saveOwner = await kb.updateDoc(doc1.id, { body: '<p>负责人强存</p>' }, editor, '强存', {})
assert(saveOwner.status === 'gate-locked', '提交人（编辑者）门禁期间同样被锁定')
const saveAdmin = await kb.updateDoc(doc1.id, { body: '<p>管理员并发修改</p>' }, admin, '管理员通道', {})
assert(saveAdmin.status === 'saved', '管理员仍可并发修改')

// ---------- 2. 权限：只读/非负责人不能确认；负责人可确认 ----------
console.log('\n[2] 影响确认权限：仅负责人/管理员；非负责人编辑者不可')
r = await gate.confirmImpact(g1.id, '我也确认', otherEditor)
assert(r.status === 'denied', '非负责人编辑者不能确认影响')
r = await gate.confirmImpact(g1.id, '只读确认', viewer)
assert(r.status === 'denied', '只读成员不能确认影响')
// doc1 拥有者是 u-admin；用管理员确认
r = await gate.confirmImpact(g1.id, '影响已核对：鉴权问答与外发链接', admin)
assert(r.status === 'ok', '负责人（管理员）确认影响成功')
const g1b = await db.changeGates.get(g1.id)
assert(g1b.status === GATE.PENDING_APPROVAL && g1b.ownerConfirmedBy === 'u-admin', '门禁进入待管理员审批')

// ---------- 3. 非管理员不能审批放行 ----------
console.log('\n[3] 审批权限：仅管理员可放行/回退/驳回')
r = await gate.decideGate(g1.id, 'release', '', editor)
assert(r.status === 'denied', '编辑者不能审批放行')

// ---------- 4. 管理员回退：版本不发布、引用/链接恢复 ----------
console.log('\n[4] 管理员回退：版本不发布，问答引用与共享链接恢复')
r = await gate.decideGate(g1.id, 'rollback', '鉴权表述需再核对，先回退', admin)
assert(r.status === 'ok' && r.released === false, '回退成功')
const g1c = await db.changeGates.get(g1.id)
assert(g1c.status === GATE.ROLLED_BACK && g1c.releaseVersion === null, '门禁已回退且无发布版本')
d1 = await db.docs.get(doc1.id)
assert(!d1.activeGateId, '文档解除门禁锁定')
assert(isDocGateCitable(d1, null), '问答引用已恢复')
const restoredSv = await db.shares.get(sv.share.id)
const restoredSe = await db.shares.get(se.share.id)
assert(shareStatus(restoredSv) === 'active' && !restoredSv.gateHoldAt, '只读共享链接已恢复')
assert(shareStatus(restoredSe) === 'active', '可编辑共享链接已恢复')
assert(g1c.impact.share.every((x) => x.state === ITEM_STATE.ROLLED_BACK), '受影响链接状态回写为 rolled_back')
assert(g1c.impact.qa.every((x) => x.state === ITEM_STATE.ROLLED_BACK), '受影响问答状态回写为 rolled_back')
// 回退未产生新版本（管理员的并发保存产生了 v2，门禁本身不追加版本）
const afterRollback = await db.docs.get(doc1.id)
const noteLast = afterRollback.versions[afterRollback.versions.length - 1]
assert(!noteLast.gate, '回退不产生门禁发布版本标记')

// ---------- 5. 完整放行链路：提交 → 确认 → 放行（版本发布/引用恢复指向新版）----------
console.log('\n[5] 放行：回写新版本、恢复引用与链接、逐项回写 released')
const doc2 = await mkDoc({ title: '入职指引', body: '<p>第一天完成账号开通与环境搭建。</p>', ownerId: 'u-chen', editors: ['u-chen'] })
const sh = await share.createShare(doc2.id, 'view', 0, editor)
const t2 = await gap.createTicket({ question: '入职指引第一天做什么？', detail: '' }, viewer)
const beforeVer = (await db.docs.get(doc2.id)).versions.length
r = await gate.submitGate(doc2.id, patch(doc2, '<p>第一天完成账号开通、环境搭建与导师一对一面谈。</p>'), '补充导师面谈', editor)
assert(r.status === 'ok', '第二篇文档提交门禁成功')
const g2 = r.gate
assert(g2.impact.counts.qa >= 1 && g2.impact.counts.share === 1, '冻结问答引用与共享链接')
// 负责人即拥有者陈思涵（editor）确认
r = await gate.confirmImpact(g2.id, '入职问答与外发链接影响确认', editor)
assert(r.status === 'ok', '文档拥有者（编辑者）可确认影响')
r = await gate.decideGate(g2.id, 'release', '影响可控，放行', admin)
assert(r.status === 'ok' && r.released === true, '管理员审批放行成功')
const d2 = await db.docs.get(doc2.id)
assert(d2.versions.length === beforeVer + 1, '放行追加了一个新版本')
const newVer = d2.versions[d2.versions.length - 1]
assert(newVer.gate && newVer.gate.status === GATE.RELEASED, '新版本带门禁放行标记')
assert(d2.body.includes('导师一对一面谈'), '新版本正文已回写')
assert(!d2.activeGateId, '放行后解除锁定')
assert(isDocGateCitable(d2, null), '放行后问答引用恢复（指向新版）')
const shAfter = await db.shares.get(sh.share.id)
assert(shareStatus(shAfter) === 'active', '放行后共享链接恢复')
const g2after = await db.changeGates.get(g2.id)
assert(g2after.releaseVersion === newVer.version, '门禁回填发布版本号')
assert(g2after.impact.all.every((x) => x.state === ITEM_STATE.RELEASED), '全部受影响项回写为 released')

// ---------- 6. 驳回：版本不发布、引用/链接恢复 ----------
console.log('\n[6] 管理员驳回：版本不发布，引用/链接恢复')
const doc3 = await mkDoc({ title: '故障排查手册', ownerId: 'u-admin' })
await share.createShare(doc3.id, 'view', 0, editor)
r = await gate.submitGate(doc3.id, patch(doc3), '补充排查步骤', editor)
const g3 = r.gate
await gate.confirmImpact(g3.id, '', admin)
r = await gate.decideGate(g3.id, 'reject', '步骤不准确，驳回', admin)
assert(r.status === 'ok', '驳回成功')
const d3 = await db.docs.get(doc3.id)
assert((await db.changeGates.get(g3.id)).status === GATE.REJECTED, '门禁已驳回')
assert(isDocGateCitable(d3, null) && !d3.activeGateId, '驳回后引用恢复、解锁')

// ---------- 7. 提交人撤回 ----------
console.log('\n[7] 提交人撤回：版本不发布，恢复引用/链接')
const doc4 = await mkDoc({ title: '安全基线', ownerId: 'u-chen', editors: ['u-chen', 'u-admin'] })
const sh4 = await share.createShare(doc4.id, 'edit', 0, editor)
r = await gate.submitGate(doc4.id, patch(doc4), '收紧密码策略', editor)
const g4 = r.gate
assert(shareStatus(await db.shares.get(sh4.share.id)) === 'suspended', '撤回前链接挂起')
r = await gate.withdrawGate(g4.id, editor)
assert(r.status === 'ok', '提交人撤回成功')
const g4b = await db.changeGates.get(g4.id)
assert(g4b.status === GATE.ROLLED_BACK && g4b.withdrawn === true, '撤回按回退处理并留痕')
assert(shareStatus(await db.shares.get(sh4.share.id)) === 'active', '撤回后链接恢复')

// 非提交人不能撤回
const doc5 = await mkDoc({ title: '另一篇文档', ownerId: 'u-admin' })
r = await gate.submitGate(doc5.id, patch(doc5), '', editor)
r = await gate.withdrawGate(r.gate.id, otherEditor)
assert(r.status === 'denied', '非提交人不能撤回他人门禁')

// ---------- 8. 重复门禁 / 评审互斥 / 退役文档 ----------
console.log('\n[8] 占用互斥：重复门禁拒绝；门禁期间不能再提交')
const doc6 = await mkDoc({ title: '互斥文档', ownerId: 'u-admin' })
r = await gate.submitGate(doc6.id, patch(doc6), '', editor)
assert(r.status === 'ok', '首次提交成功')
r = await gate.submitGate(doc6.id, patch(doc6), '', editor)
assert(r.status === 'duplicate', '流转中门禁不可重复提交')

// 访客/只读不能提交（用一篇无在途门禁的新文档，否则会先命中 duplicate）
const docGuest = await mkDoc({ title: '只读不可提交文档', ownerId: 'u-admin' })
r = await gate.submitGate(docGuest.id, patch(docGuest), '', viewer)
assert(r.status === 'denied' || r.status === 'guest', '只读成员不能提交门禁')

// ---------- 9. 影响面纯函数 ----------
console.log('\n[9] buildImpact：问答/工单/链接分类与去重')
const doc7 = await mkDoc({ title: 'Vue 组件设计', body: '<p>Props 往下传，事件往上抛。</p>', ownerId: 'u-admin' })
await gap.createTicket({ question: 'Vue 组件设计怎么拆分？', detail: '' }, viewer)
await gap.createTicket({ question: '无关问题 XYZ', detail: '' }, viewer)
await share.createShare(doc7.id, 'view', 0, editor)
const allGaps = await db.gapTickets.toArray()
const allShares = await db.shares.where('docId').equals(doc7.id).toArray()
const imp = buildImpact(await db.docs.get(doc7.id), { gapTickets: allGaps, shares: allShares, tagNames: [{ id: 't-api', name: 'API' }] })
assert(imp.qa.some((x) => x.title.includes('Vue 组件设计')), '命中标题的问题计入问答引用')
assert(!imp.qa.some((x) => x.title.includes('无关问题')), '不相关问题不计入')
assert(imp.share.length === 1, '有效共享链接计入')

// ---------- 10. 门禁期间不生成新共享链接 ----------
console.log('\n[10] 门禁挂起期间不生成新共享链接')
const doc8 = await mkDoc({ title: '门禁中分享受限', ownerId: 'u-admin' })
r = await gate.submitGate(doc8.id, patch(doc8), '', editor)
const cs = await share.createShare(doc8.id, 'view', 0, editor)
assert(cs.status === 'gate-open' || cs.status === 'denied', '门禁期间创建共享链接被拒绝')

// ---------- 11. 门禁期间删除文档被拦截 ----------
console.log('\n[11] 门禁流转中删除文档被拦截')
const del = await kb.deleteDoc(doc8.id, admin)
assert(del.status === 'in-gate', '门禁流转中不允许删除文档')

// ---------- 12. 侧栏/中心派生 ----------
console.log('\n[12] 待处理派生：负责人待确认 + 管理员待审批')
await gate.reload()
await kb.reloadDocs()
const adminTodo = gate.pendingImpactFor('u-admin', 'admin', kb.docs).length + gate.pendingApprovalFor('admin').length
assert(adminTodo >= 1, '管理员有待处理门禁（doc-6 待确认）')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
