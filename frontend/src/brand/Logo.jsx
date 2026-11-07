// The PropPickz logo as inline SVG: the P mark (lime gradient), PROP (white) and PICKZ (lime).
// <Logo height={28} /> is the lockup, sized by the mark's height; the word is 100/160 of that,
// centred on the mark. Mark and Word render alone too. The intro lands on [data-apex-logo] and
// reads the mark's and the word's boxes ([data-logo-mark], [data-logo-word]) to match them.
import { useId } from 'react'
import { MARK, WORD, LOCKUP, BRAND } from './wordmark.js'

const cleanId = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '')
const r2 = (v) => Math.round(v * 100) / 100

export function Mark({ height = 28, className = '', ...rest }) {
  const id = `pzm${cleanId(useId())}`
  return (
    <svg className={`logo-mark ${className}`} viewBox={`0 0 ${MARK.w} ${MARK.h}`} height={height} width={r2((height * MARK.w) / MARK.h)} aria-hidden="true" focusable="false" {...rest}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={MARK.h} x2={MARK.w} y2="0">
          <stop offset="0" stopColor={BRAND.markFrom} />
          <stop offset="0.55" stopColor={BRAND.markMid} />
          <stop offset="1" stopColor={BRAND.markTo} />
        </linearGradient>
      </defs>
      <g fill={`url(#${id})`}>
        <path d={MARK.p} />
        {MARK.lines.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  )
}

export function Word({ height = 18, className = '', mono = false, ...rest }) {
  const id = `pzw${cleanId(useId())}`
  return (
    <svg className={`logo-word ${className}`} viewBox={`0 0 ${WORD.w} ${WORD.h}`} height={height} width={r2((height * WORD.w) / WORD.h)} aria-hidden="true" focusable="false" {...rest}>
      {!mono && (
        <defs>
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={WORD.pickzX} y1={WORD.h} x2={WORD.w} y2="0">
            <stop offset="0" stopColor={BRAND.pickzFrom} />
            <stop offset="1" stopColor={BRAND.pickzTo} />
          </linearGradient>
        </defs>
      )}
      <path d={WORD.prop} fill={mono ? 'currentColor' : BRAND.white} />
      <path d={WORD.pickz} fill={mono ? 'currentColor' : `url(#${id})`} />
    </svg>
  )
}

/** The lockup. height is the mark's height in px; the word follows at the banner's proportions. */
export function Logo({ height = 28, className = '', label = 'PropPickz' }) {
  const wordH = (height * WORD.h) / LOCKUP.h
  const gap = (height * (LOCKUP.word.x - LOCKUP.mark.w)) / LOCKUP.h
  return (
    <span className={`logo ${className}`} role="img" aria-label={label} data-apex-logo style={{ '--logo-gap': `${r2(gap)}px` }}>
      <Mark height={height} data-logo-mark="" />
      <Word height={r2(wordH)} data-logo-word="" />
    </span>
  )
}
