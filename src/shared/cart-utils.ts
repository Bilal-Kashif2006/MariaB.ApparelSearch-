import type { CartItem } from './contracts';

export function parsePriceAmount(priceStr: string): number {
  if (!priceStr) return 0;
  const match = priceStr.match(/\d[\d,.]*/);
  if (!match) return 0;
  const cleaned = match[0].replace(/,/g, '');
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : 0;
}

export function formatSubtotal(amount: number, samplePriceStr?: string): string {
  const currencyMatch = samplePriceStr?.match(/^(PKR|Rs\.?|₨)\s*/i);
  const prefix = currencyMatch ? currencyMatch[0].trim() + ' ' : 'PKR ';
  return `${prefix}${Math.round(amount).toLocaleString('en-PK')}`;
}

export function calculateSubtotal(items: CartItem[]): string {
  let total = 0;
  let samplePrice = '';
  for (const item of items) {
    if (!samplePrice && item.price) samplePrice = item.price;
    total += parsePriceAmount(item.price) * (item.quantity || 1);
  }
  return formatSubtotal(total, samplePrice);
}

export function matchesSizeText(targetSize: string, candidateText: string): boolean {
  if (!targetSize || !candidateText) return false;
  const target = targetSize.trim().toLowerCase();
  const cand = candidateText.trim().toLowerCase();

  if (cand === target) return true;

  const aliases: Record<string, string[]> = {
    xs: ['x-small', 'extra small', 'xs'],
    s: ['small', 's'],
    m: ['medium', 'm'],
    l: ['large', 'l'],
    xl: ['x-large', 'extra large', 'xl'],
    xxl: ['2xl', 'xx-large', 'xxl', '2x-large'],
  };

  for (const [key, list] of Object.entries(aliases)) {
    const targetMatchesGroup = target === key || list.includes(target);
    if (targetMatchesGroup) {
      if (cand === key || list.includes(cand)) return true;
      for (const item of [key, ...list]) {
        const regex = new RegExp(`\\b${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(cand)) return true;
      }
    }
  }

  const targetRegex = new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return targetRegex.test(cand);
}
