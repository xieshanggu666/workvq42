<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useGateStore } from '@/stores/gate'
import { useAuthStore } from '@/stores/auth'
import { formatDate, formatFull } from '@/utils/format'
import {
  GATE, gateStatusLabel, gateStatusCls, gateItemStateLabel, gateImpactTypeLabel,
  canConfirmImpact, canDecideGate, canWithdrawGate, gateTimelineLabel, impactGroups
} from '@/utils/gate'
import { GUEST_ID } from '@/utils/permission'
import { fieldLabels } from '@/utils/version'

const props = defineProps({ doc: { type: Object, required: true } })

const router = useRouter()
const gateStore = useGateStore()
const auth = useAuthStore()

const noteText = ref('')
const decisionOpen = ref(false)
const busy = ref(false)
const justDone = ref('')

const gates = computed(() => gateStore.gatesOfDoc(props.doc.id))
const active = computed(() => gateStore.openGateOfDoc(props.doc.id))
const latest = computed(() => gates.value[0] || null)

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))

const groups = computed(() => (active.value ? impactGroups(active.value.impact) : { qa: [], gap: [], share: [] }))
const counts = computed(() => active.value?.impact?.counts || { qa: 0, gap: 0, share: 0, total: 0 })

const canConfirm = computed(() =>
  canConfirmImpact(active.value, props.doc, auth.user?.id || GUEST_ID, auth.user?.role))
const canDecide = computed(() => canDecideGate(active.value, auth.user?.id, auth.user?.role))
const canWithdraw = computed(() => canWithdrawGate(active.value, auth.user?.id))
// 发起门禁：可编辑文档的编辑者/管理员，且无流转门禁（限时协作只读成员不显示该通道）
const canSubmit = computed(() => {
  if (active.value) return false
  const role = auth.user?.role
  if (role !== 'admin' && role !== 'editor') return false
  if (auth.user?.id === GUEST_ID) return false
  if (auth.user?.role === 'admin') return true
  return props.doc.ownerId === auth.user.id || (props.doc.editors || []).includes(auth.user.id)
})

async function confirmImpact() {
  if (!active.value || busy.value) return
  busy.value = true
  try {
    const res = await gateStore.confirmImpact(active.value.id, noteText.value.trim(), auth.user)
    if (res.status === 'ok') {
      justDone.value = '已确认影响，等待管理员审批放行'
      noteText.value = ''
      setTimeout(() => { justDone.value = '' }, 3000)
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('只有文档负责人或管理员可以确认影响。')
    } else {
      alert('操作失败：门禁状态已变化，请刷新后重试')
    }
  } finally {
    busy.value = false
  }
}

async function decide(decision) {
  if (!active.value || busy.value) return
  busy.value = true
  try {
    const res = await gateStore.decideGate(active.value.id, decision, noteText.value.trim(), auth.user)
    if (res.status === 'ok') {
      justDone.value = decision === 'release'
        ? '已放行：版本已发布，问答引用与共享链接已恢复'
        : decision === 'rollback' ? '已回退：版本不发布，引用与链接已恢复' : '已驳回：版本不发布，引用与链接已恢复'
      decisionOpen.value = false
      noteText.value = ''
      setTimeout(() => { justDone.value = '' }, 4000)
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('只有管理员可以审批发布门禁。')
    } else {
      alert('操作失败：门禁状态已变化，请刷新后重试')
    }
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  if (!active.value) return
  if (!confirm('确定撤回本次发布门禁？待发布版本不会生效，问答引用与共享链接将恢复。')) return
  busy.value = true
  try {
    const res = await gateStore.withdrawGate(active.value.id, auth.user)
    if (res.status === 'denied' || res.status === 'guest') alert('只有门禁提交人可以撤回。')
    else if (res.status !== 'ok') alert('撤回失败：门禁状态已变化，请刷新后重试。')
  } finally {
    busy.value = false
  }
}

function sharePermText(p) { return p === 'edit' ? '可编辑' : '仅查看' }
</script>

<template>
  <div class="gate card">
    <div class="g-head">
      <span class="g-title">🚦 变更影响评估与发布门禁</span>
      <span v-if="active" class="st" :class="gateStatusCls(active.status)">
        {{ gateStatusLabel(active.status) }}
      </span>
      <button v-if="canSubmit" class="btn sm primary" @click="router.push('/docs/' + doc.id + '/edit?submitGate=1')">
        提交版本走门禁
      </button>
    </div>

    <div v-if="justDone" class="toast-line">✅ {{ justDone }}</div>

    <!-- 流转中的门禁 -->
    <div v-if="active" class="g-body">
      <div class="g-meta">
        <span class="who">{{ userById[active.submittedBy]?.name || active.submittedBy }} 提交版本</span>
        <span class="tm">{{ formatFull(active.submittedAt) }}</span>
        <span class="ver">基于 v{{ active.baseVersion }}</span>
        <span v-if="active.releaseVersion" class="rel-ver">已发布 v{{ active.releaseVersion }}</span>
      </div>

      <div v-if="active.changeFields?.length" class="diff-line">
        放行后将更新：<b>{{ fieldLabels(active.changeFields).join('、') }}</b>
      </div>

      <!-- 影响确认进度 -->
      <div class="flow">
        <span class="step done">① 编辑者提交版本</span>
        <span class="arrow">→</span>
        <span class="step" :class="{ done: active.status !== GATE.PENDING_IMPACT }">② 负责人确认影响</span>
        <span class="arrow">→</span>
        <span class="step" :class="{ done: false }">③ 管理员审批</span>
      </div>
      <div v-if="active.status === GATE.PENDING_APPROVAL" class="owner-line">
        负责人 <b>{{ userById[active.ownerConfirmedBy]?.name || active.ownerConfirmedBy }}</b>
        已于 {{ formatDate(active.ownerConfirmedAt) }} 确认影响<template v-if="active.ownerNote">：“{{ active.ownerNote }}”</template>
      </div>

      <!-- 受影响项 -->
      <div class="impact">
        <div class="im-title">受影响范围（{{ counts.total }}）：问答引用 {{ counts.qa }} · 缺口工单 {{ counts.gap }} · 共享链接 {{ counts.share }}</div>

        <div v-if="groups.qa.length" class="im-group">
          <div class="im-gt">💬 问答引用（{{ groups.qa.length }}）· 门禁期间已暂停引用</div>
          <div v-for="it in groups.qa" :key="it.id" class="im-item">
            <span class="im-name">{{ it.title }}</span>
            <span class="im-state" :class="'ist-' + it.state">{{ gateItemStateLabel(it.state) }}</span>
          </div>
          <div v-if="!groups.qa.length" class="im-empty"></div>
        </div>

        <div v-if="groups.gap.length" class="im-group">
          <div class="im-gt">📮 缺口工单（{{ groups.gap.length }}）</div>
          <div v-for="it in groups.gap" :key="it.id" class="im-item">
            <span class="im-name">{{ it.title }}<em class="im-reason">{{ it.reason }}</em></span>
            <span class="im-state" :class="'ist-' + it.state">{{ gateItemStateLabel(it.state) }}</span>
          </div>
        </div>

        <div v-if="groups.share.length" class="im-group">
          <div class="im-gt">🔗 共享链接（{{ groups.share.length }}）· 门禁期间已挂起</div>
          <div v-for="it in groups.share" :key="it.id" class="im-item">
            <span class="im-name mono">{{ it.title }}<em class="im-reason">{{ sharePermText(it.permission) }}</em></span>
            <span class="im-state" :class="'ist-' + it.state">{{ gateItemStateLabel(it.state) }}</span>
          </div>
        </div>

        <div v-if="!counts.total" class="im-none">本次变更暂无关联的问答引用、缺口工单或共享链接</div>
      </div>

      <!-- 负责人确认影响 -->
      <div v-if="canConfirm && active.status === GATE.PENDING_IMPACT" class="confirm-box">
        <textarea v-model="noteText" rows="2" placeholder="负责人确认影响说明（可选，将留痕）"></textarea>
        <div class="acts">
          <button class="btn sm primary" :disabled="busy" @click="confirmImpact">确认影响，提交管理员审批</button>
        </div>
      </div>

      <!-- 管理员审批 -->
      <div v-if="canDecide" class="decision">
        <button v-if="!decisionOpen" class="btn sm" @click="decisionOpen = true">审批处理</button>
        <template v-else>
          <textarea v-model="noteText" rows="2" placeholder="审批意见（可选，将留痕）"></textarea>
          <div class="decision-actions">
            <button class="btn sm ok-solid" :disabled="busy" @click="decide('release')">✓ 审批放行（发布版本、恢复引用/链接）</button>
            <button class="btn sm back-solid" :disabled="busy" @click="decide('rollback')">↩ 回退（版本不发布）</button>
            <button class="btn sm" :disabled="busy" @click="decide('reject')">✕ 驳回</button>
            <button class="btn sm ghost" @click="decisionOpen = false">取消</button>
          </div>
        </template>
      </div>

      <div v-if="canWithdraw && !canDecide" class="withdraw-row">
        <button class="btn sm ghost" :disabled="busy" @click="withdraw">撤门禁</button>
      </div>
    </div>

    <!-- 无流转门禁：最近结论 -->
    <div v-else-if="latest" class="last-decision">
      <span class="st sm" :class="gateStatusCls(latest)">{{ gateStatusLabel(latest.status) }}</span>
      <span class="ld-text">
        {{ userById[latest.submittedBy]?.name || latest.submittedBy }} 提交 ·
        <template v-if="latest.decidedBy">{{ userById[latest.decidedBy]?.name || latest.decidedBy }} 于 {{ formatDate(latest.decidedAt) }} 结论</template>
        <template v-else>提交人撤回</template>
        <template v-if="latest.releaseVersion"> · 已发布 v{{ latest.releaseVersion }}</template>
      </span>
    </div>
    <div v-else class="g-empty">编辑者提交版本时可选择「走发布门禁」：先评估对问答引用、缺口工单与共享链接的影响，负责人确认后由管理员审批放行。</div>
  </div>
</template>

<style scoped>
.gate { margin-top: 14px; padding: 18px 24px; }
.g-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.g-title { font-weight: 700; font-size: 15px; }
.g-head .btn { margin-left: auto; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st.sm { font-size: 11px; padding: 1px 8px; }
.st-impact { background: #fef3c7; color: #b45309; }
.st-approval { background: #e0e7ff; color: #4338ca; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-back { background: #f1f5f9; color: #475569; }
.toast-line { color: #15803d; font-size: 13px; margin-bottom: 10px; }
.g-meta { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); flex-wrap: wrap; }
.who { font-weight: 600; }
.tm, .ver { color: var(--text-3); font-size: 12px; }
.rel-ver { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #dcfce7; color: #15803d; font-weight: 600; }
.diff-line { margin-top: 10px; font-size: 13px; color: var(--text-2); background: var(--primary-weak); border-radius: 8px; padding: 8px 12px; }
.diff-line b { color: var(--primary); margin-right: 2px; }
.flow { display: flex; align-items: center; gap: 8px; margin: 12px 0 6px; font-size: 12.5px; flex-wrap: wrap; }
.flow .step { color: var(--text-3); }
.flow .step.done { color: #15803d; font-weight: 600; }
.flow .arrow { color: var(--text-3); }
.owner-line { font-size: 12.5px; color: #4338ca; background: #eef2ff; border-radius: 8px; padding: 7px 12px; margin-bottom: 10px; }
.impact { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
.im-title { font-weight: 600; font-size: 13px; color: var(--text-2); margin-bottom: 8px; }
.im-group { margin-bottom: 10px; }
.im-group:last-child { margin-bottom: 0; }
.im-gt { font-size: 12px; color: var(--text-3); margin-bottom: 4px; font-weight: 600; }
.im-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12.5px; padding: 4px 0; border-bottom: 1px dashed var(--panel-2); }
.im-item:last-child { border-bottom: none; }
.im-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.im-name.mono { font-family: Menlo, Consolas, monospace; }
.im-reason { font-style: normal; color: var(--text-3); font-size: 11px; margin-left: 8px; }
.im-state { font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.ist-affected { background: #fef3c7; color: #b45309; }
.ist-released { background: #dcfce7; color: #15803d; }
.ist-rejected { background: #fee2e2; color: #b91c1c; }
.ist-rolled_back { background: #f1f5f9; color: #475569; }
.im-none { font-size: 12.5px; color: var(--text-3); }
.confirm-box textarea, .decision textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; margin-bottom: 8px; }
.confirm-box textarea:focus, .decision textarea:focus { border-color: var(--primary); }
.acts, .decision-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.decision { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.back-solid { background: #475569; border-color: #475569; color: #fff; }
.btn.back-solid:hover { background: #334155; color: #fff; }
.withdraw-row { margin-top: 10px; }
.last-decision { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 10px 14px; flex-wrap: wrap; }
.g-empty { font-size: 13px; color: var(--text-3); background: var(--panel-2); border-radius: 8px; padding: 10px 14px; line-height: 1.6; }
</style>
