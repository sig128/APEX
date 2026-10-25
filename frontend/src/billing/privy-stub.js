// Stand-in used at build time when Privy isn't configured (no VITE_PRIVY_APP_ID) or not
// installed, so the wallet SDK never ends up in the bundle. PayFlow never renders it then.
export function PrivyProvider({ children }) {
  return children
}
export const usePrivy = () => ({ ready: false, authenticated: false, login() {}, logout() {} })
export const useWallets = () => ({ ready: false, wallets: [] })
