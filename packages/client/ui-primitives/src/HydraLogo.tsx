import type { IconProps } from './icons/props.ts'

/** Native square viewBox edge of the Hydra mark, in user units. */
export const HYDRA_LOGO_VIEWBOX = 64

/**
 * The dragon's face seen from the front, as its left and right halves (the
 * right mirrors the left across the vertical centre line): a crest at the
 * brow, two horns sweeping up and back, flared cheek spikes, and a tapering
 * snout ending in two fangs. Exported so consumers that compose their own
 * svg (the favicon, entrance effects) share the same drawing.
 */
export const HYDRA_LOGO_FACE = [
  'M32 5L29 15C26 13 24 11 22 8C19 4 14 1 7 0C12 4 14 10 15 18C11 17 7 15 2 12C6 19 9 23 12 26L4 33L13 34L9 43L18 41L21 51L24 60L27 55L29 59L32 62Z',
  'M32 5L35 15C38 13 40 11 42 8C45 4 50 1 57 0C52 4 50 10 49 18C53 17 57 15 62 12C58 19 55 23 52 26L60 33L51 34L55 43L46 41L43 51L40 60L37 55L35 59L32 62Z',
] as const

/** The ridge down the brow and nose, drawn in the canvas color at half opacity. */
export const HYDRA_LOGO_RIDGE = 'M32 14L30.8 30L32 42L33.2 30Z'

/** The slanted eye sockets, cut out in the canvas color. */
export const HYDRA_LOGO_EYES = [
  'M16 29L28 34L25 37.5L18 34.5Z',
  'M48 29L36 34L39 37.5L46 34.5Z',
] as const

/** The pupils inside the sockets, in the brand highlight. */
export const HYDRA_LOGO_PUPILS = [
  'M21.5 32L25.5 34.2L24 36Z',
  'M42.5 32L38.5 34.2L40 36Z',
] as const

/** The nostrils near the snout's tip, cut out in the canvas color. */
export const HYDRA_LOGO_NOSTRILS = [
  { cx: 28.5, cy: 54 },
  { cx: 35.5, cy: 54 },
] as const

/**
 * Render the Hydra mark: the front-facing dragon's face filled in the
 * current text color, the ridge, eye sockets, and nostrils in the base
 * background, and the pupils in the brand highlight token (the text color as
 * fallback). The pupils carry `data-part="pupil"` so a host can light them.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the product name for accessibility).
 */
export function HydraLogo({ size = 24, className }: IconProps) {
  const canvas = 'var(--dsw-alias-bg-base, #ffffff)'
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${HYDRA_LOGO_VIEWBOX} ${HYDRA_LOGO_VIEWBOX}`}
      fill="currentColor"
      aria-hidden="true"
    >
      {HYDRA_LOGO_FACE.map(d => <path key={d} d={d} />)}
      <path d={HYDRA_LOGO_RIDGE} fill={canvas} opacity={0.5} />
      {HYDRA_LOGO_EYES.map(d => <path key={d} d={d} fill={canvas} />)}
      {HYDRA_LOGO_PUPILS.map(d => <path key={d} d={d} data-part="pupil" fill="var(--dsw-alias-brand-highlight, currentColor)" />)}
      {HYDRA_LOGO_NOSTRILS.map(n => <ellipse key={`${n.cx}-${n.cy}`} cx={n.cx} cy={n.cy} rx={1.2} ry={2} fill={canvas} />)}
    </svg>
  )
}
