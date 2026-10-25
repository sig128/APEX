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
}

/** Every live topic is free; kept as a hook in case a topic ever needs a plan. */
export function topicAllowed() {
  return true
}

export const TOPIC_RE = /^(scoreboard|tracker|status|game:\d{6,12}|props:\d{6,12})$/
