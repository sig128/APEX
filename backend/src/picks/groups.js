// Private groups: friends or a league with their own leaderboard. A member with a pass starts one
// and shares its code; anyone with a picks page can join with the code. The board ranks the
// group's members by the same graded record their page shows, over the window picked, so a group
// is a smaller, private view of records that can't be edited after kickoff.
import crypto from 'node:crypto'
import { ApiError } from '../lib/router.js'

export const MAX_MEMBERS = 50
export const MAX_GROUPS = 10
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0 or 1 to misread
export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/
const ID_RE = /^g_[0-9a-f]{16}$/

export const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('')
const cleanName = (v) =>
  String(v || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
export const readCode = (v) =>
  String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8)

/**
 * docs: the documents store. picks: { profileOf(uid), rowsFor(uids, opts) }. isMember(user): a
 * real Pro or Elite pass (or the admin).
 */
export function createGroups({ docs, picks, isMember = async () => false, now = () => Date.now() }) {
  async function needPage(user) {
    if (!user?.uid || user.uid === 'admin') throw new ApiError(401, 'signin', 'Sign in first.')
    const p = await picks.profileOf(user.uid)
    if (!p) throw new ApiError(409, 'no_profile', 'Make your picks page first: groups rank the records on it.')
    return p
  }
  const view = (g, uid) => ({
    id: g.id,
    name: g.name,
    members: g.members.length,
    owner: g.owner === uid,
    // only the owner sees the code (members share the link the owner gives them)
    code: g.owner === uid ? g.code : null,
    createdAt: g.createdAt,
  })

  async function mine(user) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in first.')
    const idx = await docs.get('groupsOf', user.uid)
    const out = []
    for (const id of idx?.ids || []) {
      const g = await docs.get('groups', id)
      if (g && g.members.some((m) => m.uid === user.uid)) out.push(view(g, user.uid))
    }
    return { groups: out, max: MAX_GROUPS, canCreate: await isMember(user) }
  }

  async function create(user, { name } = {}) {
    await needPage(user)
    if (!(await isMember(user))) throw new ApiError(402, 'upgrade', 'Starting a group is for members with a Pro or Elite pass. Anyone with a picks page can join one.', { need: 'pro' })
    const n = cleanName(name)
    if (n.length < 3) throw new ApiError(400, 'bad_name', 'Give the group a name of 3 to 40 characters.')
    const t = now()
    const id = `g_${crypto.randomBytes(8).toString('hex')}`
    let code = newCode()
    const g = await docs.tx(async (tx) => {
      const idx = (await tx.get('groupsOf', user.uid)) || { ids: [] }
      const taken = await tx.get('groupCodes', code)
      if (idx.ids.length >= MAX_GROUPS) throw new ApiError(409, 'too_many', `You can be in ${MAX_GROUPS} groups at once. Leave one first.`)
      if (taken) code = newCode() // a clash in 32^8 codes: try once more (the next read would be after a write)
      const doc = { id, name: n, owner: user.uid, code, members: [{ uid: user.uid, at: t }], createdAt: t, updatedAt: t }
      tx.set('groups', id, doc)
      tx.set('groupCodes', code, { gid: id, at: t })
      tx.set('groupsOf', user.uid, { ids: [id, ...idx.ids] })
      return doc
    })
    return { group: view(g, user.uid) }
  }

  /** What a code opens, before joining: the name and how many are in it. */
  async function preview(code) {
    const c = readCode(code)
    if (!CODE_RE.test(c)) throw new ApiError(404, 'no_group', 'That code doesn’t match a group. Check it with whoever sent it.')
    const link = await docs.get('groupCodes', c)
    const g = link && (await docs.get('groups', link.gid))
    if (!g || g.code !== c) throw new ApiError(404, 'no_group', 'That code doesn’t match a group. It may have been changed.')
    const owner = await picks.profileOf(g.owner)
    return { name: g.name, members: g.members.length, full: g.members.length >= MAX_MEMBERS, owner: owner?.handle || null }
  }

  async function join(user, { code } = {}) {
    await needPage(user)
    const c = readCode(code)
    if (!CODE_RE.test(c)) throw new ApiError(404, 'no_group', 'That code doesn’t match a group. Check it with whoever sent it.')
    const t = now()
    const g = await docs.tx(async (tx) => {
      const link = await tx.get('groupCodes', c)
      const g0 = link ? await tx.get('groups', link.gid) : null
      const idx = (await tx.get('groupsOf', user.uid)) || { ids: [] }
      if (!g0 || g0.code !== c) throw new ApiError(404, 'no_group', 'That code doesn’t match a group. It may have been changed.')
      if (g0.members.some((m) => m.uid === user.uid)) return g0
      if (g0.members.length >= MAX_MEMBERS) throw new ApiError(409, 'full', `This group is full (${MAX_MEMBERS} people).`)
      if (idx.ids.length >= MAX_GROUPS) throw new ApiError(409, 'too_many', `You can be in ${MAX_GROUPS} groups at once. Leave one first.`)
      const next = { ...g0, members: [...g0.members, { uid: user.uid, at: t }], updatedAt: t }
      tx.set('groups', g0.id, next)
      tx.set('groupsOf', user.uid, { ids: [g0.id, ...idx.ids.filter((x) => x !== g0.id)] })
      return next
    })
    return { group: view(g, user.uid) }
  }

  async function load(user, id, { owner = false } = {}) {
    if (!user?.uid) throw new ApiError(401, 'signin', 'Sign in first.')
    if (!ID_RE.test(String(id))) throw new ApiError(404, 'no_group', 'No such group.')
    const g = await docs.get('groups', id)
    const inIt = g?.members.some((m) => m.uid === user.uid)
    if (!g || (!inIt && !user.admin)) throw new ApiError(404, 'no_group', 'No such group, or you’re not in it.')
    if (owner && g.owner !== user.uid) throw new ApiError(403, 'not_owner', 'Only the person who started the group can do that.')
    return g
  }

  /** The group's board: everyone in it, ranked; people without graded picks in the window last. */
  async function board(user, id, opts = {}) {
    const g = await load(user, id)
    const out = await picks.rowsFor(
      g.members.map((m) => m.uid),
      opts,
    )
    return { group: view(g, user.uid), ...out, rows: out.rows.map((r) => ({ ...r, you: r.uid === user.uid, owner: r.uid === g.owner, uid: undefined })) }
  }

  async function leave(user, id) {
    const g = await load(user, id)
    const t = now()
    await docs.tx(async (tx) => {
      const cur = await tx.get('groups', g.id)
      const idx = (await tx.get('groupsOf', user.uid)) || { ids: [] }
      if (!cur) return
      const members = cur.members.filter((m) => m.uid !== user.uid)
      tx.set('groupsOf', user.uid, { ids: idx.ids.filter((x) => x !== g.id) })
      if (!members.length) {
        tx.del('groups', g.id)
        tx.del('groupCodes', cur.code)
        return
      }
      // the owner leaving hands the group to whoever has been in it longest
      const owner = cur.owner === user.uid ? [...members].sort((a, b) => a.at - b.at)[0].uid : cur.owner
      tx.set('groups', g.id, { ...cur, members, owner, updatedAt: t })
    })
    return { ok: true }
  }

  async function removeMember(user, id, { handle } = {}) {
    const g = await load(user, id, { owner: true })
    const h = String(handle || '').toLowerCase()
    const who = await docs.get('profileHandles', h)
    if (!who || !g.members.some((m) => m.uid === who.uid)) throw new ApiError(404, 'not_member', 'That person isn’t in this group.')
    if (who.uid === user.uid) throw new ApiError(400, 'self', 'To go, leave the group instead.')
    await docs.tx(async (tx) => {
      const cur = await tx.get('groups', g.id)
      const idx = (await tx.get('groupsOf', who.uid)) || { ids: [] }
      if (!cur) return
      tx.set('groups', g.id, { ...cur, members: cur.members.filter((m) => m.uid !== who.uid), updatedAt: now() })
      tx.set('groupsOf', who.uid, { ids: idx.ids.filter((x) => x !== g.id) })
    })
    return { ok: true }
  }

  async function rename(user, id, { name } = {}) {
    const g = await load(user, id, { owner: true })
    const n = cleanName(name)
    if (n.length < 3) throw new ApiError(400, 'bad_name', 'Give the group a name of 3 to 40 characters.')
    await docs.merge('groups', g.id, { name: n, updatedAt: now() })
    return { group: view({ ...g, name: n }, user.uid) }
  }

  /** A new code: the old link stops working (for when it went further than meant). */
  async function resetCode(user, id) {
    const g = await load(user, id, { owner: true })
    const code = newCode()
    await docs.tx(async (tx) => {
      const taken = await tx.get('groupCodes', code)
      if (taken) throw new ApiError(409, 'retry', 'Try that again.')
      tx.del('groupCodes', g.code)
      tx.set('groupCodes', code, { gid: g.id, at: now() })
      tx.merge('groups', g.id, { code, updatedAt: now() })
    })
    return { group: view({ ...g, code }, user.uid) }
  }

  async function remove(user, id) {
    const g = await load(user, id, { owner: true })
    await docs.tx(async (tx) => {
      const idxs = []
      for (const m of g.members) idxs.push([m.uid, (await tx.get('groupsOf', m.uid)) || { ids: [] }])
      for (const [uid, idx] of idxs) tx.set('groupsOf', uid, { ids: idx.ids.filter((x) => x !== g.id) })
      tx.del('groups', g.id)
      tx.del('groupCodes', g.code)
    })
    return { ok: true }
  }

  return { mine, create, preview, join, board, leave, removeMember, rename, resetCode, remove }
}
