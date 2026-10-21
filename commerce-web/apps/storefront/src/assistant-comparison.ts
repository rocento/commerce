import type { ComparisonClearResult } from './comparison';

/** Called only for a newly received, validated clear-comparison event, never history. */
export function clearComparisonReply(comparison: { clear: () => ComparisonClearResult } | null): { cleared: boolean; text: string } {
  if (!comparison) return { cleared: false, text: 'Comparison is unavailable here. Open the comparison page and choose Clear all.' };
  try {
    const result = comparison.clear();
    const text = result.removed > 0
      ? `Removed ${result.removed} ${result.removed === 1 ? 'product' : 'products'} from your comparison list. The list is now empty.`
      : 'Your comparison list is now empty.';
    return { cleared: true, text: result.persisted ? text : `${text} This change could not be saved, so the list may return after a refresh.` };
  } catch {
    return { cleared: false, text: 'I couldn’t confirm that the comparison list was cleared. Please check the comparison page and try again.' };
  }
}
