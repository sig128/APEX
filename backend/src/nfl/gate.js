// Which NFL endpoints need which plan. Stats are free for everyone; AI reads need Pro.
export const ROUTE_TIER = {
  status: 'free',
  week: 'free',
  home: 'free',
  board: 'free',
  props: 'free',
  games: 'free',
  players: 'free',
  live: 'free',
  track: 'free',
  search: 'free',
  dvp: 'free',
  rankings: 'free',
  insight: 'pro',
  sim: 'pro',
  check: 'pro',
  intel: 'pro',
  lock: 'pro',
  shop: 'free',
  // decides for itself: the live list for members, a delayed snapshot for everyone else
  ticker: 'free',
  // live signals decide for themselves too: the notes for members, the record for everyone
  signals: 'free',
}

/** Every live topic is free; kept as a hook in case a topic ever needs a plan. */
export function topicAllowed() {
  return true
}

/** Topics only members get live; the stream drops them for anyone else. */
export const PAID_TOPICS = new Set(['ticker'])

export const TOPIC_RE = /^(scoreboard|tracker|status|ticker|game:\d{6,12}|props:\d{6,12})$/
