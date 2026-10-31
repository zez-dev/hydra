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

/** Japanese dictionary; the product name is not translated. */
export const ja = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>

/** Spanish dictionary; the product name is not translated. */
export const es = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>

/** French dictionary; the product name is not translated. */
export const fr = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>

/** German dictionary; the product name is not translated. */
export const de = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>

/** Russian dictionary; the product name is not translated. */
export const ru = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>

/** Portuguese dictionary; the product name is not translated. */
export const pt = {
  name: 'Hydra',
} satisfies Record<BrandHydraKey, string>
