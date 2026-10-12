/** `brand-hydra` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  name: 'Hydra',
} satisfies Record<string, string>

/** The brand namespace key union. */
export type BrandHydraKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>
