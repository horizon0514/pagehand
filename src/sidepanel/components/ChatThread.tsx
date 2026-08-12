import { useEffect, useRef } from 'react';
import { ArrowUpRight, FileText, MousePointer2, TableProperties } from 'lucide-react';
import { DisplayMessage } from '../state/conversationStore';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../../lib/i18n';
import MessageBubble from './MessageBubble';
import BrandMark from './BrandMark';
import { SectionLabel } from './ui/label';

/**
 * Export leads: it is the one job here that no chat assistant with web access
 * can do for you, because it needs the session you are already signed into.
 *
 * `promptKey` exists for it too — a chip has room for three words and the
 * instruction that actually produces a clean export is a sentence, so what is
 * shown and what is sent come apart here.
 */
const SUGGESTIONS: { icon: typeof FileText; key: MessageKey; promptKey?: MessageKey }[] = [
  { icon: TableProperties, key: 'empty.suggest.exportTable', promptKey: 'export.prompt' },
  { icon: FileText, key: 'empty.suggest.summarize' },
  { icon: MousePointer2, key: 'empty.suggest.clickLogin' },
];

export function EmptyIntro() {
  const t = useT();
  return (
    <div className="animate-enter w-full max-w-[320px] text-center">
      <BrandMark size={36} className="mx-auto mb-3" />
      <p className="mb-1.5 text-[10px] font-semibold tracking-[0.16em] text-fg-tertiary uppercase">
        Pagehand
      </p>
      <h2 className="text-[14px] font-semibold tracking-[-0.02em] text-fg">{t('empty.title')}</h2>
      <p className="mt-1.5 text-[12.5px] leading-[1.5] text-fg-secondary">{t('empty.body')}</p>
    </div>
  );
}

export function EmptySuggestions({ onPick }: { onPick: (text: string) => void }) {
  const t = useT();
  return (
    <div className="animate-enter w-full max-w-[320px]">
      <SectionLabel className="mb-2 text-center">{t('empty.tryOne')}</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {SUGGESTIONS.map(({ icon: Icon, key, promptKey }) => {
          const text = t(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPick(promptKey ? t(promptKey) : text)}
              className="group flex h-9 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-left text-[12.5px] text-fg-secondary outline-none transition-[background-color,border-color,color] duration-200 hover:border-line-strong hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-line"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-bg text-fg-tertiary transition-colors duration-200 group-hover:bg-accent-soft group-hover:text-accent-text">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{text}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-fg-tertiary opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ChatThread({
  messages,
  isStreaming,
  onSend,
}: {
  messages: DisplayMessage[];
  isStreaming: boolean;
  /** Backs the Continue / Retry buttons on the last message. */
  onSend: (text: string) => void;
}) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distance < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'instant' : 'smooth' });
  }, [messages, isStreaming]);

  return (
    <div
      ref={scrollerRef}
      className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 pt-3.5 pb-28"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={isStreaming}
    >
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const actionable = isLast && !isStreaming;
        const asked = messages[i - 1]?.role === 'user' ? messages[i - 1].text : undefined;

        return (
          <MessageBubble
            key={m.id}
            message={m}
            isStreaming={isStreaming && isLast}
            onContinue={actionable ? () => onSend(t('message.continuePrompt')) : undefined}
            onRetry={actionable && asked ? () => onSend(asked) : undefined}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
