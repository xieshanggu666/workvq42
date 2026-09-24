// 共享链接：统一的链接生成与状态判定
// 查看 / 编辑 / 撤销 / 过期 四处共用，保证链接状态与文档访问权限始终一致

const base = typeof location !== 'undefined' ? location.origin + location.pathname : ''

// 文档正常访问链接（详情页）
export function docUrl(docId) {
  return base + '#/docs/' + docId
}

// 共享链接（凭 token 访问）
export function shareUrl(token) {
  return base + '#/share/' + token
}

// 链接状态：active 有效 | suspended 门禁挂起 | expired 已过期 | revoked 已撤销 | invalid 不存在
// suspended：链接本身有效，但文档处于发布门禁流转中（变更影响评估），临时暂停访问/编辑，
// 门禁放行/驳回/回退后自动恢复 active（不撤销链接、记录保留）。
export function shareStatus(share, now = new Date()) {
  if (!share) return 'invalid'
  if (share.revokedAt) return 'revoked'
  if (share.gateHoldAt) return 'suspended'
  if (share.expiresAt && new Date(share.expiresAt) <= now) return 'expired'
  return 'active'
}

// 链接是否可实际访问/编辑：未撤销、未过期、且未被发布门禁挂起。
// 门禁挂起（suspended）只是临时暂停，放行/驳回/回退后恢复，但其挂起期间与撤销同样不可用。
export function isShareActive(share, now) {
  return shareStatus(share, now) === 'active'
}

// 链接记录是否仍然「存续」（未撤销、未过期）：门禁挂起也算存续——区别于已撤销/过期，
// 用于区分「临时挂起待恢复」与「永久失效」
export function isShareAlive(share, now) {
  const st = shareStatus(share, now)
  return st === 'active' || st === 'suspended'
}

// 只有「有效且权限为 edit」的链接才可编辑文档（门禁挂起期间不可编辑）
export function canShareEdit(share, now) {
  return isShareActive(share, now) && share.permission === 'edit'
}

export function shareStatusLabel(status) {
  return { active: '有效', suspended: '门禁挂起', expired: '已过期', revoked: '已撤销', invalid: '无效' }[status] || status
}
