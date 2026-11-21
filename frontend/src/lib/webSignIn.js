// In the iPhone app, "Buy on proppickz.com instead" only helps someone who can sign in on the
// website as the same account (a pass belongs to the account) and only while the website sells.
// The website offers Google, and Apple once its web settings are in place (the server says which).

/** The Firebase sign-ins this person has, as provider ids ('google.com', 'apple.com'). */
export const providersOf = (user) => (user?.providerData || []).map((p) => p?.providerId).filter(Boolean)

/** Whether the website's checkout can work for this account: it sells, and it can sign them in. */
export function webCheckoutFits({ user, webSignIn = ['google'], webSells = false } = {}) {
  if (!webSells) return false
  const web = new Set((webSignIn || []).map((p) => `${p}.com`))
  return providersOf(user).some((id) => web.has(id))
}
