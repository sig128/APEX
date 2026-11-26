// The betting apps a member picks in the setup: sportsbooks, pick'em and fantasy apps, prediction
// markets. Each shows its own App Store icon (Apple's picture of it, never redrawn here) on a glow
// in its color, and the ones offered where the member bets come first. The server keeps the icons
// current (/api/operators/icons: backend/src/members/operatorIcons.js); the ones here are what
// they were when this list was made, for the first paint and for when the server can't say.
// The keys are the server's (backend/src/members/operators.js); the first eight are the books we
// have prices for, under the keys the slip uses.

const APPLE = 'https://is1-ssl.mzstatic.com/image/thumb/'
const SIZE = '180x180bb.jpg'
const P = (path, file) => `${path}/${file}`

/** name, the color its tile glows in ("r, g, b"), and its App Store icon */
export const OPERATORS = {
  fanduel: { name: 'FanDuel', glow: '20, 147, 255', icon: P('Purple221/v4/07/12/c0/0712c017-7a1b-eed4-2a62-8361190ea4a5', 'AppIcon-0-0-1x_U007emarketing-0-11-0-85-220.png') },
  draftkings: { name: 'DraftKings', glow: '99, 182, 19', icon: P('Purple211/v4/38/86/31/38863132-acdd-1ce7-0895-b9eab324baf6', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  betmgm: { name: 'BetMGM', glow: '200, 179, 122', icon: P('Purple221/v4/4d/bd/ec/4dbdecc3-a871-604b-a644-bea724e4a8f5', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  williamhill_us: { name: 'Caesars', glow: '40, 140, 108', icon: P('Purple211/v4/ac/b6/0e/acb60e1d-dea3-4281-31b5-15af8229abae', 'AppIcon-0-0-1x_U007epad-0-1-0-sRGB-85-220.png') },
  bet365: { name: 'bet365', glow: '20, 140, 90', icon: P('Purple221/v4/ed/65/31/ed653134-ef3e-acfb-8b14-b453c662899c', 'AppIcon-US-0-0-1x_U007epad-0-1-0-sRGB-85-220.png') },
  fanatics: { name: 'Fanatics', glow: '205, 210, 216', icon: P('Purple211/v4/33/48/97/33489752-5a72-e8a9-c959-0ea1b1c22e25', 'AppIcon-0-0-1x_U007ephone-0-1-85-220.png') },
  betrivers: { name: 'BetRivers', glow: '230, 92, 30', icon: P('Purple221/v4/f1/55/bb/f155bb98-44c1-a950-b80d-8e142d1b0fa0', 'AppIconFallLeaves-0-0-1x_U007epad-0-1-0-85-220.png') },
  espnbet: { name: 'theScore Bet', glow: '30, 90, 230', icon: P('Purple211/v4/91/57/93/91579380-c752-95f0-889d-235f32af0ef0', 'theScoreUS-AppIcon-0-0-1x_U007ephone-0-1-0-85-220.png') },
  hardrockbet: { name: 'Hard Rock Bet', glow: '110, 76, 230', icon: P('Purple221/v4/91/c1/5c/91c15cb1-e45b-1d31-3991-6073eb8bfe6e', 'SportsAppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  prizepicks: { name: 'PrizePicks', glow: '130, 40, 255', icon: P('Purple221/v4/cc/be/99/ccbe99cb-47c0-464c-399c-855583d2c57a', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  underdog: { name: 'Underdog', glow: '240, 222, 20', icon: P('Purple221/v4/36/d2/51/36d2512c-5dfc-7fb1-f618-6005c34f0944', 'underdog-0-0-1x_U007ephone-0-1-0-85-220.png') },
  sleeper: { name: 'Sleeper', glow: '96, 110, 220', icon: P('Purple211/v4/ed/2b/ad/ed2badbd-7b9a-e5df-4cf2-8bcd0bbb5e5e', 'AppIcon-Thanksgiving-0-0-1x_U007epad-0-1-85-220.png') },
  pick6: { name: 'DraftKings Pick6', short: 'Pick6', glow: '239, 109, 27', icon: P('Purple221/v4/5c/51/5c/5c515cfb-c3e5-ca6e-0c09-a846a8e99cd9', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  betr: { name: 'Betr', glow: '170, 100, 245', icon: P('Purple211/v4/d8/c0/ed/d8c0edba-e006-6a41-677c-fae69f934cd7', 'AppIcon-0-0-1x_U007epad-0-1-P3-85-220.png') },
  dabble: { name: 'Dabble', glow: '119, 67, 255', icon: P('Purple211/v4/8c/a6/3a/8ca63a02-a591-4521-359b-15384bb6a41a', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  kalshi: { name: 'Kalshi', glow: '0, 219, 146', icon: P('Purple211/v4/0f/a4/ba/0fa4ba6e-643d-cab1-2138-bc6f3db17a84', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  polymarket: { name: 'Polymarket', glow: '45, 120, 255', icon: P('Purple221/v4/f9/c2/3c/f9c23cc1-4e02-261c-94ce-8f352f083590', 'AppIcon2-0-0-1x_U007ephone-0-1-0-sRGB-85-220.png') },
  novig: { name: 'Novig', glow: '205, 210, 216', icon: P('Purple211/v4/60/03/bd/6003bd89-8373-3ab2-0888-3b7fb882acc8', 'AppIcon-0-0-1x_U007ephone-0-1-85-220.png') },
  prophetx: { name: 'ProphetX', glow: '20, 180, 90', icon: P('Purple211/v4/52/f7/bf/52f7bf7f-aaf7-7701-8476-b2a0e800e3ff', 'AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png') },
  fliff: { name: 'Fliff', glow: '90, 60, 230', icon: P('Purple211/v4/3c/4a/b0/3c4ab047-38cc-ca79-cab7-51415378bec3', 'AppIcon-0-0-1x_U007ephone-0-1-85-220.png') },
  ballybet: { name: 'Bally Bet', glow: '210, 60, 80', icon: P('Purple221/v4/f1/b7/fc/f1b7fc23-5ebe-b351-b7ee-4f8105090aa1', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  parlayplay: { name: 'ParlayPlay', glow: '253, 205, 17', icon: P('Purple221/v4/77/ab/db/77abdba0-2e04-4e58-e3f0-91783b83df77', 'AppIcon-0-0-1x_U007emarketing-0-11-0-85-220.png') },
  chalkboard: { name: 'Chalkboard', glow: '205, 210, 216', icon: P('Purple211/v4/57/4c/c8/574cc89d-9c30-ecc0-bdea-0ced70c50b0b', 'AppIcon-0-0-1x_U007emarketing-0-6-85-220.png') },
  boom: { name: 'Boom', glow: '96, 186, 228', icon: P('Purple221/v4/94/13/7c/94137c16-ecc9-6daf-4034-c9b20d5c6117', 'AppIcon-0-0-1x_U007emarketing-0-7-0-85-220.png') },
  rebet: { name: 'ReBet', glow: '222, 92, 49', icon: P('Purple211/v4/cc/72/a2/cc72a2b2-f720-c302-0b1b-f98a2052da54', 'AppIcon-0-0-1x_U007ephone-0-1-85-220.jpeg') },
  betopenly: { name: 'BetOpenly', glow: '214, 40, 46', icon: P('Purple211/v4/67/63/45/67634511-7cd5-9cee-1ef3-5606f48ddde8', 'AppIcon-0-0-1x_U007ephone-0-1-85-220.png') },
  proline: { name: 'PROLINE', glow: '160, 225, 60', icon: P('Purple221/v4/e6/54/cc/e654cccd-8c5e-5b1f-b38c-40f639975bf7', 'AppIcon-0-0-1x_U007ephone-0-1-0-85-220.png') },
  miseojeu: { name: 'Mise-o-jeu+', glow: '235, 30, 30', icon: P('Purple211/v4/a4/a3/27/a4a32776-5533-be3d-f51b-88c11dd1bd3a', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  playnow: { name: 'PlayNow', glow: '0, 186, 77', icon: P('Purple211/v4/a8/1e/cd/a81ecdf7-13e3-db7b-21ce-1282faa752ab', 'AppIcon_Multi-0-1x_U007emarketing-0-8-0-85-220-0.png') },
  playalberta: { name: 'PlayAlberta', glow: '61, 228, 200', icon: P('Purple211/v4/a5/3f/d6/a53fd633-d029-b6d0-09b5-9432a47cdaf1', 'AppIcon-0-0-1x_U007ephone-0-1-0-85-220.png') },
  pointsbet: { name: 'PointsBet', glow: '227, 26, 64', icon: P('Purple221/v4/1e/b8/19/1eb8199b-6480-ca01-2a48-0f3705cd3b9f', 'AppIcon-sportsbook-0-1x_U007emarketing-0-8-0-85-220-0.png') },
  bet99: { name: 'BET99', glow: '36, 160, 80', icon: P('Purple211/v4/d8/05/21/d805219a-86ea-4148-abf7-6ab79c1ca505', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  sportsinteraction: { name: 'Sports Interaction', glow: '243, 90, 20', icon: P('Purple211/v4/cf/aa/3a/cfaa3a10-f946-de4a-2794-a520146e67cf', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  betway: { name: 'Betway', glow: '0, 170, 50', icon: P('Purple211/v4/37/6e/da/376eda49-e0b2-1fe3-0d39-1344d3eb9028', 'SportsROWAppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  betano: { name: 'Betano', glow: '254, 70, 30', icon: P('Purple211/v4/48/5f/89/485f8986-2525-35ff-d62d-ce0855b267b7', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  betvictor: { name: 'BetVictor', glow: '88, 175, 208', icon: P('Purple211/v4/15/bc/f0/15bcf06c-c0f3-4769-ff02-09ae749ab76c', 'AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png') },
  tonybet: { name: 'TonyBet', glow: '140, 60, 210', icon: P('Purple211/v4/f9/f8/e9/f9f8e9c5-1eab-b727-194c-519b85658e2b', 'AppIcon-0-0-1x_U007ephone-0-1-0-85-220.png') },
  northstarbets: { name: 'NorthStar Bets', glow: '40, 110, 220', icon: P('Purple221/v4/29/24/e4/2924e492-aa5d-a7da-e1f7-ce95d0bd5bb3', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  powerplay: { name: 'PowerPlay', glow: '220, 30, 50', icon: P('Purple221/v4/0d/b9/58/0db95809-b28e-b0c4-2987-db1646984340', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  betfair: { name: 'Betfair', glow: '251, 182, 12', icon: P('Purple221/v4/ae/77/18/ae77184a-d4a8-0c54-88e2-413a09260e1e', 'AppIcon-0-0-1x_U007emarketing-0-9-0-85-220.png') },
  williamhill: { name: 'William Hill', glow: '60, 80, 190', icon: P('Purple221/v4/63/ee/2c/63ee2c66-448b-79db-abb9-758ef70b9d14', 'AppIcon-0-0-1x_U007epad-0-1-0-sRGB-85-220.png') },
  skybet: { name: 'Sky Bet', glow: '230, 30, 40', icon: P('Purple221/v4/86/5e/1f/865e1fc0-a61a-c609-5e57-e6571803ceec', 'AppIcon-0-0-1x_U007emarketing-0-11-0-85-220.png') },
  paddypower: { name: 'Paddy Power', glow: '20, 130, 90', icon: P('Purple211/v4/d3/32/90/d3329079-8f19-a2c7-3f94-0d4c845207d0', 'AppIcon-0-0-1x_U007epad-0-11-0-85-220.png') },
  ladbrokes: { name: 'Ladbrokes', glow: '240, 31, 41', icon: P('Purple211/v4/fe/ed/eb/feedeb40-125e-2347-a19c-44803c3d1e80', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  coral: { name: 'Coral', glow: '20, 90, 225', icon: P('Purple221/v4/8c/f0/50/8cf050b6-84ad-c315-de33-1f0c37c092a4', 'AppIcon-0-0-1x_U007epad-0-1-0-85-220.png') },
  betfred: { name: 'Betfred', glow: '120, 40, 230', icon: P('Purple221/v4/f4/bb/91/f4bb91ad-717c-d80d-dcad-acb5b75c5cad', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  unibet: { name: 'Unibet', glow: '63, 169, 56', icon: P('Purple211/v4/e1/00/98/e10098bd-faf1-d574-b8f4-fa76a4f8f37f', 'AppIcon-0-0-1x_U007epad-0-1-0-sRGB-85-220.png') },
  boylesports: { name: 'BoyleSports', glow: '50, 40, 246', icon: P('Purple221/v4/74/78/70/7478708b-1508-e5e0-6765-15e43df06786', 'AppIcon-0-0-1x_U007emarketing-0-6-0-85-220.png') },
  sport888: { name: '888sport', glow: '107, 206, 50', icon: P('Purple211/v4/08/29/d3/0829d3b8-fef4-35f4-73f0-bedc56049df3', 'AppIcon-0-0-1x_U007emarketing-0-11-0-sRGB-85-220.png') },
  smarkets: { name: 'Smarkets', glow: '13, 187, 135', icon: P('Purple221/v4/15/b1/f4/15b1f415-e4b8-59f7-89e0-7d5c491a174e', 'AppIcon-0-0-1x_U007epad-0-1-85-220.png') },
  matchbook: { name: 'Matchbook', glow: '197, 28, 29', icon: P('Purple211/v4/1e/99/4f/1e994f1b-0c1d-c8dd-b9aa-9ceaa39e2cd6', 'AppIcon-0-0-1x_U007ephone-0-1-0-85-220.png') },
}

export const OPERATOR_KEYS = Object.keys(OPERATORS)

// Who comes first where. The order is roughly how many people use each one there; showing an app
// first says nothing about whether it's legal or open where the member is.
const US = ['fanduel', 'draftkings', 'betmgm', 'williamhill_us', 'fanatics', 'espnbet', 'betrivers', 'bet365', 'hardrockbet', 'prizepicks', 'underdog', 'sleeper', 'pick6', 'betr', 'dabble', 'parlayplay', 'kalshi', 'polymarket', 'novig', 'prophetx', 'fliff']
const US_MORE = ['ballybet', 'chalkboard', 'boom', 'rebet', 'betopenly']
// each province's own lottery corporation's app
const PROVINCIAL = { ON: 'proline', QC: 'miseojeu', BC: 'playnow', MB: 'playnow', SK: 'playnow', AB: 'playalberta' }
const CANADA = ['espnbet', 'bet365', 'fanduel', 'draftkings', 'betmgm', 'betrivers', 'williamhill_us', 'pointsbet', 'bet99', 'sportsinteraction', 'betway', 'betano', 'betvictor', 'tonybet', 'northstarbets', 'powerplay', 'hardrockbet', 'underdog']
const ELSEWHERE = ['bet365', 'betfair', 'williamhill', 'skybet', 'paddypower', 'ladbrokes', 'coral', 'betfred', 'unibet', 'betway', 'betvictor', 'betano', 'boylesports', 'sport888', 'smarkets', 'matchbook', 'polymarket', 'dabble']

/**
 * The operators to show first for where the member bets ("US-NY", "CA-ON", "other"; nothing yet
 * reads as the US), and the rest in groups: { first: [key], rest: [[title, [key]]] }.
 */
export function operatorsFor(region) {
  const m = /^(US|CA)-([A-Z]{2})$/.exec(String(region || ''))
  const country = region === 'other' ? 'other' : m ? m[1] : 'US'
  const lottery = [...new Set(Object.values(PROVINCIAL))]
  const first = country === 'CA' ? [PROVINCIAL[m[2]], ...CANADA].filter(Boolean) : country === 'other' ? ELSEWHERE : US
  const groups = {
    US: [country === 'US' ? 'More in the US' : 'United States', [...US, ...US_MORE]],
    CA: [country === 'CA' ? 'More in Canada' : 'Canada', [...lottery, ...CANADA]],
    other: ['Elsewhere', ELSEWHERE],
  }
  const order = country === 'CA' ? ['CA', 'US', 'other'] : country === 'other' ? ['other', 'US', 'CA'] : ['US', 'CA', 'other']
  const seen = new Set(first)
  const rest = []
  for (const g of order) {
    const [title, keys] = groups[g]
    const left = keys.filter((k) => !seen.has(k))
    left.forEach((k) => seen.add(k))
    if (left.length) rest.push([title, left])
  }
  return { first: [...new Set(first)], rest }
}

const APPLE_ICON = /^https:\/\/is\d-ssl\.mzstatic\.com\/image\/thumb\//

/** The operator's App Store icon: the server's current one when it has it (`fresh`), else ours. */
export function iconOf(key, fresh = null) {
  const live = fresh?.[key]
  if (typeof live === 'string' && APPLE_ICON.test(live)) return live
  const o = OPERATORS[key]
  return o ? `${APPLE}${o.icon}/${SIZE}` : null
}

/** "FanDuel"; the short form where a tile is narrow ("Pick6"). */
export function operatorName(key, { short = false } = {}) {
  const o = OPERATORS[key]
  return o ? (short && o.short) || o.name : ''
}
