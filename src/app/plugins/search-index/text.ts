const EXTRA_FOLDS: Record<string, string> = {
  ł: 'l',
  đ: 'd',
  ø: 'o',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
};

/** Lowercase and strip diacritics, so "zolw" matches "Żółw". */
export const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[łđøßæœ]/g, (ch) => EXTRA_FOLDS[ch] ?? ch);

export const tokenize = (text: string): string[] => {
  const words = normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return Array.from(new Set(words));
};
