// Keeping what people post clean (App Review Guideline 1.2: apps where people post must filter
// objectionable words, let people report it and block whoever posts it). Profanity and slurs, in
// the usual disguises (l33t, repeated letters), are refused in picks notes, page names, handles,
// bios and group names. Betting words that only contain a bad word ("assists", "Hancock") pass.
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'
import { ApiError } from './router.js'

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers })

export const objectionable = (text) => Boolean(text) && matcher.hasMatch(String(text))

/** Throws a plain answer naming the field when any of them has a word we don't allow. */
export function mustBeClean(fields) {
  for (const [label, text] of Object.entries(fields)) {
    if (objectionable(text)) throw new ApiError(400, 'not_allowed', `Your ${label} has a word PropPickz doesn’t allow. Change it and try again.`)
  }
}
