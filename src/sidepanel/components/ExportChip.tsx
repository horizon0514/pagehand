import { useCallback, useEffect, useState } from 'react';
import { TableProperties } from 'lucide-react';
import { detectList, type ListDetection } from '../../lib/pages/detectList';
import { useT } from '../i18n/useT';

/**
 * The one entry point that costs no typing.
 *
 * EmptySuggestions only renders on an empty thread, so the moment someone sends
 * a first message every hint about what this can do disappears. Export is the
 * path worth keeping in reach, and a user who has to compose "collect every row
 * of this table across all pages" will never discover it.
 *
 * Shown whenever the active tab is an ordinary page. When the page could be
 * probed for free the count rides along and the chip hides on pages with no
 * list; when it could not (see detectList — no permission grant, no dialog),
 * the plain chip still shows. Guessing wrong costs a line of chrome; hiding
 * wrong costs the feature.
 */
export default function ExportChip({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  const t = useT();
  const [state, setState] = useState<ListDetection>({ scriptable: false, rows: null });

  const refresh = useCallback(() => {
    void detectList().then(setState);
  }, []);

  useEffect(() => {
    refresh();
    const onActivated = () => refresh();
    // Only on 'complete': a navigation fires onUpdated several times, and the
    // DOM is not worth counting until it has one.
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo) => {
      if (change.status === 'complete') refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refresh]);

  if (!state.scriptable) return null;
  // A successful probe that found nothing is the one case worth trusting.
  if (state.rows !== null && state.rows === 0) return null;

  return (
    <div className="mb-1.5 flex justify-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(t('export.prompt'))}
        className="group flex h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[11px] text-fg-secondary outline-none transition-[background-color,border-color,color] duration-200 hover:border-line-strong hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-line disabled:cursor-not-allowed disabled:opacity-50"
      >
        <TableProperties className="size-3 shrink-0 text-fg-tertiary transition-colors duration-200 group-hover:text-accent-text" />
        <span className="min-w-0 truncate">{t('export.chip')}</span>
        {state.rows !== null && (
          <span className="shrink-0 text-fg-tertiary">
            {t('export.chipRows', { count: state.rows })}
          </span>
        )}
      </button>
    </div>
  );
}
