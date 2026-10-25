// One lookup per request: the caller and what their plan lets them do.
export function createAccess({ auth, billing }) {
  async function resolve(req) {
    if (req.apexAccess) return req.apexAccess
    const user = await auth.identify(req)
    const ent = await billing.entitlement(user)
    req.apexAccess = { ok: true, user, ent, tier: ent.plan }
    return req.apexAccess
  }
  return { resolve }
}
