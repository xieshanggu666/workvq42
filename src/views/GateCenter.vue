<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGateStore } from '@/stores/gate'
import { formatDate, formatFull } from '@/utils/format'
import {
  GATE, gateStatusLabel, gateStatusCls, gateItemStateLabel,
  canConfirmImpact, canDecideGate, canWithdrawGate, impactGroups
} from '@/utils/gate'
import { fieldLabels } from '@/utils/version'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const gateStore = useGateStore()

const tab = ref('todo')
const noteText = ref({})
const busy = ref(false)
const expanded = ref({})

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))

// 待处理：待我确认影响（拥有者/管理员）+ 待管理员审批
const todoGates = computed(() => {
  const uid = auth.user?.id
  const role = auth.user?.role
  return gateStore.sorted.filter((g) => {
    if (g.status === GATE.PENDING_APPROVAL) return role === 'admin'
    if (g.status === GATE.PENDING_IMPACT) {
      if (role === 'admin') return true
      return docById.value[g.docId]?.ownerId === uid
    }
    return false
  })
})

// 我提交的
const mine = computed(() => gateStore.sorted.filter((g) => g.submittedBy === auth.user?.id))
// 全部（管理员可见全部；其它成员仅见与自己相关的）
const allGates = computed(() => {
  if (auth.user?.role === 'admin') return gateStore.sorted
  const uid = auth.user?.id
  return gateStore.sorted.filter((g) =>
    g.submittedBy === uid || docById.value[g.docId]?.ownerId === uid)
})

const list = computed(() => tab.value === 'todo' ? todoGates.value : tab.value === 'mine' ? mine.value : allGates.value)

function canConfirm(g, doc) {
  return canConfirmImpact(g, doc, auth.user?.id, auth.user?.role)
}
function canDecide(g) {
  return canDecideGate(g, auth.user?.id, auth.user?.role)
}
function canWithdraw(g) {
  return canWithdrawGate(g, auth.user?.id)
}
function groupsOf(g) { return impactGroups(g.impact) }

function toggle(id) { expanded.value = { ...expanded.value, [id]: !expanded.value[id] } }
function isOpen(id) { return !!expanded.value[id] }

async function confirm(g) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await gateStore.confirmImpact(g.id, (noteText.value[g.id] || '').trim(), auth.user)
    if (res.status === 'ok') noteText.value[g.id] = ''
    else alert(res.status === 'denied' || res.status === 'guest' ? '只有文档负责人或管理员可以确认影响。' : '操作失败，请刷新后重试')
  } finally {
    busy.value = false
  }
}

async function decide(g, decision) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await gateStore.decideGate(g.id, decision, (noteText.value[g.id] || '').trim(), auth.user)
    if (res.status === 'ok') noteText.value[g.id] = ''
    else alert(res.status === 'denied' || res.status === 'guest' ? '只有管理员可以审批发布门禁。' : '操作失败，请刷新后重试')
  } finally {
    busy.value = false
  }
}

async function withdraw(g) {
  if (!confirm('确定撤回本次发布门禁？待发布版本不会生效，问答引用与共享链接将恢复。')) return
  busy.value = true
  try {
    const res = await gateStore.withdrawGate(g.id, auth.user)
    if (res.status !== 'ok') alert('撤回失败：只有门禁提交人可以撤回。')
  } finally {
    busy.value = false
  }
}

const todoCount = computed(() => todoGates.value.length)

onMounted(async () => {
  await Promise.all([kb.loadAll(), gateStore.loadAll()])
})
</script>

<template>
  <div class="gate-center">
    <header class="head">
      <h2>🚦 知识变更影响评估与发布门禁</h2>
      <p class="sub">编辑者提交版本后冻结受影响的问答引用、缺口工单与共享链接；负责人确认影响，管理员审批放行或回退，并回写版本发布、引用与链接状态。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'todo' }" @click="tab = 'todo'">待处理<span v-if="todoCount" class="badge">{{ todoCount }}</span></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我提交的</button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部门禁</button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🚦</div>
      {{ tab === 'todo' ? '暂无待你处理的发布门禁' : tab === 'mine' ? '你还没有提交过发布门禁' : '暂无发布门禁记录' }}
    </div>

    <div v-for="g in list" :key="g.id" class="gate-card card">
      <div class="gc-head" @click="toggle(g.id)">
        <span class="st" :class="gateStatusCls(g.status)">{{ gateStatusLabel(g.status) }}</span>
        <span class="gc-title" @click.stop="router.push('/docs/' + g.docId)">《{{ g.docTitle }}》</span>
        <span class="gc-meta">
          {{ userById[g.submittedBy]?.name || g.submittedBy }} 提交 · {{ formatDate(g.submittedAt) }} · 基于 v{{ g.baseVersion }}
          <template v-if="g.releaseVersion"> · 已发布 v{{ g.releaseVersion }}</template>
        </span>
        <span class="arrow">{{ isOpen(g.id) ? '收起 ▲' : '展开 ▼' }}</span>
      </div>

      <div v-if="isOpen(g.id)" class="gc-body">
        <div v-if="g.changeFields?.length" class="diff-line">
          放行后将更新：<b>{{ fieldLabels(g.changeFields).join('、') }}</b>
        </div>

        <!-- 进度 -->
        <div class="flow">
          <span class="step done">① 编辑者提交版本</span>
          <span class="arrow">→</span>
          <span class="step" :class="{ done: g.status !== GATE.PENDING_IMPACT }">② 负责人确认影响</span>
          <span class="arrow">→</span>
          <span class="step" :class="{ done: g.status === GATE.RELEASED || g.status === GATE.REJECTED || g.status === GATE.ROLLED_BACK }">③ 管理员审批</span>
        </div>

        <!-- 受影响范围 -->
        <div class="impact">
          <div class="im-title">
            受影响范围（{{ g.impact?.counts?.total || 0 }}）：
            问答引用 {{ g.impact?.counts?.qa || 0 }} · 缺口工单 {{ g.impact?.counts?.gap || 0 }} · 共享链接 {{ g.impact?.counts?.share || 0 }}
          </div>
          <template v-for="(grp, key) in { qa: groupsOf(g).qa, gap: groupsOf(g).gap, share: groupsOf(g).share }" :key="key">
            <div v-if="grp.length" class="im-group">
              <div class="im-gt">{{ key === 'qa' ? '💬 问答引用' : key === 'gap' ? '📮 缺口工单' : '🔗 共享链接' }}（{{ grp.length }}）</div>
              <div v-for="it in grp" :key="it.id" class="im-item">
                <span class="im-name" :class="{ mono: key === 'share' }">
                  {{ it.title }}
                  <em v-if="it.reason" class="im-reason">{{ it.reason }}</em>
                  <em v-else-if="it.permission" class="im-reason">{{ it.permission === 'edit' ? '可编辑' : '仅查看' }}</em>
                </span>
                <span class="im-state" :class="'ist-' + it.state">{{ gateItemStateLabel(it.state) }}</span>
              </div>
            </div>
          </template>
          <div v-if="!g.impact?.counts?.total" class="im-none">本次变更暂无关联的问答引用、缺口工单或共享链接</div>
        </div>

        <!-- 操作区 -->
        <template v-if="g.status === GATE.PENDING_IMPACT || g.status === GATE.PENDING_APPROVAL">
          <textarea v-model="noteText[g.id]" rows="2" :placeholder="canDecide(g) ? '审批意见（可选，将留痕）' : '影响确认说明（可选，将留痕）'"></textarea>
          <div class="acts">
            <button v-if="canConfirm(g, docById[g.docId])" class="btn sm primary" :disabled="busy" @click="confirm(g)">
              确认影响，提交管理员审批
            </button>
            <template v-if="canDecide(g)">
              <button class="btn sm ok-solid" :disabled="busy" @click="decide(g, 'release')">✓ 审批放行</button>
              <button class="btn sm back-solid" :disabled="busy" @click="decide(g, 'rollback')">↩ 回退</button>
              <button class="btn sm" :disabled="busy" @click="decide(g, 'reject')">✕ 驳回</button>
            </template>
            <button v-if="canWithdraw(g)" class="btn sm ghost" :disabled="busy" @click="withdraw(g)">撤门禁</button>
          </div>
        </template>

        <!-- 结论 -->
        <div v-else class="conclusion">
          <span v-if="g.decidedBy">{{ userById[g.decidedBy]?.name || g.decidedBy }} 于 {{ formatFull(g.decidedAt) }} {{ gateStatusLabel(g.status) }}</span>
          <span v-else>提交人于 {{ formatFull(g.decidedAt) }} 撤门禁</span>
          <span v-if="g.decisionNote" class="cn-note">“{{ g.decisionNote }}”</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gate-center { max-width: 880px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); margin-bottom: 16px; }
.tabs { display: flex; gap: 8px; margin-bottom: 14px; }
.tabs button { padding: 7px 16px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel); cursor: pointer; font-size: 13px; color: var(--text-2); position: relative; }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; }
.badge { margin-left: 6px; background: var(--danger); color: #fff; font-size: 11px; border-radius: 999px; padding: 0 7px; min-width: 18px; height: 16px; display: inline-grid; place-items: center; }
.tabs button.on .badge { background: #fff; color: var(--primary); }
.empty { padding: 48px 20px; text-align: center; color: var(--text-3); }
.empty .ico { font-size: 36px; margin-bottom: 10px; }
.gate-card { padding: 0; margin-bottom: 12px; overflow: hidden; }
.gc-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; cursor: pointer; flex-wrap: wrap; }
.gc-title { font-weight: 700; cursor: pointer; }
.gc-title:hover { color: var(--primary); }
.gc-meta { color: var(--text-3); font-size: 12px; }
.arrow { margin-left: auto; color: var(--text-3); font-size: 12px; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.st-impact { background: #fef3c7; color: #b45309; }
.st-approval { background: #e0e7ff; color: #4338ca; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-back { background: #f1f5f9; color: #475569; }
.gc-body { padding: 4px 18px 18px; border-top: 1px solid var(--border); }
.diff-line { font-size: 13px; color: var(--text-2); background: var(--primary-weak); border-radius: 8px; padding: 8px 12px; margin: 12px 0; }
.diff-line b { color: var(--primary); }
.flow { display: flex; align-items: center; gap: 8px; margin: 12px 0; font-size: 12.5px; flex-wrap: wrap; }
.flow .step { color: var(--text-3); }
.flow .step.done { color: #15803d; font-weight: 600; }
.flow .arrow { color: var(--text-3); margin: 0; }
.impact { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
.im-title { font-weight: 600; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }
.im-group { margin-bottom: 10px; }
.im-group:last-child { margin-bottom: 0; }
.im-gt { font-size: 12px; color: var(--text-3); margin-bottom: 4px; font-weight: 600; }
.im-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12.5px; padding: 4px 0; border-bottom: 1px dashed var(--panel-2); }
.im-item:last-child { border-bottom: none; }
.im-name { color: var(--text); }
.im-name.mono { font-family: Menlo, Consolas, monospace; }
.im-reason { font-style: normal; color: var(--text-3); font-size: 11px; margin-left: 8px; }
.im-state { font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.ist-affected { background: #fef3c7; color: #b45309; }
.ist-released { background: #dcfce7; color: #15803d; }
.ist-rejected { background: #fee2e2; color: #b91c1c; }
.ist-rolled_back { background: #f1f5f9; color: #475569; }
.im-none { font-size: 12.5px; color: var(--text-3); }
.gc-body textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; margin: 6px 0 10px; }
.gc-body textarea:focus { border-color: var(--primary); }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.back-solid { background: #475569; border-color: #475569; color: #fff; }
.btn.back-solid:hover { background: #334155; color: #fff; }
.conclusion { font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 10px 14px; }
.cn-note { color: var(--text-3); margin-left: 6px; }
</style>
