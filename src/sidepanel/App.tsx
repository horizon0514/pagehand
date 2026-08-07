import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useSettings } from './hooks/useSettings';
import { useAgentSession } from './hooks/useAgentSession';
import { useHostedAuth } from './hooks/useHostedAuth';
import ChatThread, { EmptyIntro, EmptySuggestions } from './components/ChatThread';
import SettingsPanel from './components/SettingsPanel';
import BoundTabBar from './components/BoundTabBar';
import LedgerPanel from './components/LedgerPanel';
import ExportChip from './components/ExportChip';
import ResultBar from './components/ResultBar';
import ExportTaskList from './components/ExportTaskList';
import { useExportTasks } from './hooks/useExportTasks';
import { useLedger } from './hooks/useLedger';
import ThreadSwitcher from './components/ThreadSwitcher';
import TabMentionMenu from './components/TabMentionMenu';
import BrandMark from './components/BrandMark';
import { useTabMentions } from './hooks/useTabMentions';
import { useT } from './i18n/useT';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { cn } from './lib/utils';

interface PendingPrompt {
  tabId: number;
  selectionText?: string;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-xs border border-line bg-bg px-1 font-sans text-[9.5px] leading-[14px] text-fg-tertiary">
      {children}
    </kbd>
  );
}

function BootSkeleton() {
  const t = useT();
  return (
    <div className="flex h-screen flex-col bg-bg" aria-busy="true" aria-label={t('app.loading')}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="skeleton size-5" />
        <div className="skeleton h-3.5 w-28" />
        <div className="skeleton ml-auto size-6" />
      </header>
      <div className="flex h-7 items-center gap-2 border-b border-line px-3">
        <div className="skeleton size-1.5 rounded-full" />
        <div className="skeleton h-2.5 w-40" />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-3">
        <div className="skeleton h-16 w-[70%]" />
        <div className="skeleton h-[72px] w-full max-w-[320px] rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Shown when the settings say hosted and there is no account behind them.
 *
 * Sits on the composer rather than in a corner: this is the one thing standing
 * between the user and a working extension, and the composer is where they are
 * looking when they find out.
 */
function SignInNotice({ onSignIn }: { onSignIn: () => void }) {
  const t = useT();
  return (
    <div
      role="status"
      className="mb-1.5 flex items-center gap-2 rounded-xl border border-caution/25 bg-caution-soft px-2.5 py-1.5"
    >
      <p className="min-w-0 flex-1 text-[11.5px] leading-[1.4] text-fg">{t('auth.signedOut')}</p>
      <Button type="button" size="sm" onClick={onSignIn}>
        {t('auth.signIn')}
      </Button>
    </div>
  );
}

function Composer({
  input,
  setInput,
  inputRef,
  isStreaming,
  canSend,
  needsSignIn,
  onSignIn,
  onSubmit,
  onStop,
}: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  canSend: boolean;
  needsSignIn: boolean;
  onSignIn: () => void;
  onSubmit: (e: FormEvent) => void;
  onStop: () => void;
}) {
  const t = useT();
  const mentions = useTabMentions(input, setInput, inputRef);

  return (
    <form className="relative w-full" onSubmit={onSubmit}>
      {needsSignIn && <SignInNotice onSignIn={onSignIn} />}
      {mentions.open && (
        <TabMentionMenu
          items={mentions.items}
          query={mentions.query}
          activeIndex={mentions.activeIndex}
          onHover={mentions.setActiveIndex}
          onPick={mentions.choose}
        />
      )}
      <div
        className={cn(
          'rounded-2xl border border-line bg-surface/95 px-3 pt-2.5 pb-2 shadow-[var(--shadow-popover)] backdrop-blur-md transition-[border-color,box-shadow] duration-200',
          'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-line',
          isStreaming && 'opacity-95',
        )}
      >
        <label htmlFor="composer-input" className="sr-only">
          {t('app.message')}
        </label>
        <Textarea
          id="composer-input"
          ref={inputRef}
          rows={1}
          value={input}
          // Deliberately usable mid-run: sending takes the turn over.
          placeholder={
            isStreaming ? t('composer.placeholderStreaming') : t('composer.placeholder')
          }
          onChange={(e) => {
            setInput(e.target.value);
            mentions.sync();
          }}
          onClick={mentions.sync}
          onSelect={mentions.sync}
          onBlur={mentions.close}
          onKeyDown={(e) => {
            // IME (e.g. Chinese Pinyin): Enter confirms composition — don't send.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            // The @-menu gets first refusal: its Enter picks a tab, not send.
            if (mentions.handleKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!input.trim()) return;
              // Submit via form requestSubmit so the form onSubmit path stays consistent.
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className="min-h-[44px] max-h-40 overflow-y-auto"
        />
        <div className="flex items-center justify-between gap-2 pt-1.5">
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-fg-tertiary select-none">
            {isStreaming ? (
              <span className="flex items-center gap-1.5 text-caution">
                <span className="flex gap-[3px]" aria-hidden>
                  <span className="animate-pulse-dot size-1 rounded-full bg-current" />
                  <span className="animate-pulse-dot size-1 rounded-full bg-current [animation-delay:180ms]" />
                  <span className="animate-pulse-dot size-1 rounded-full bg-current [animation-delay:360ms]" />
                </span>
                {canSend ? t('composer.takesOver') : t('composer.agentRunning')}
                <span className="mx-0.5 text-line-strong">·</span>
                {canSend ? (
                  <>
                    <Kbd>↵</Kbd> {t('composer.redirectAction')}
                  </>
                ) : (
                  <>
                    <Kbd>esc</Kbd> {t('composer.stopAction')}
                  </>
                )}
              </span>
            ) : (
              <>
                <Kbd>↵</Kbd> {t('composer.sendAction')}
                <span className="mx-0.5 text-line-strong">·</span>
                <Kbd>⇧↵</Kbd> {t('composer.newlineAction')}
              </>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {isStreaming && (
              <Button
                type="button"
                size="icon-sm"
                variant="danger"
                onClick={onStop}
                aria-label={t('composer.stop')}
                title={t('composer.stopTitle')}
              >
                <Square className="size-2.5 fill-current" strokeWidth={0} />
              </Button>
            )}
            {/* Stays mounted while streaming so a mid-run message can take over. */}
            {(!isStreaming || canSend) && (
              <Button
                type="submit"
                size="icon-sm"
                variant={canSend ? 'default' : 'subtle'}
                disabled={!canSend}
                aria-label={isStreaming ? t('composer.sendTakeover') : t('composer.sendLabel')}
                className={cn(canSend && 'shadow-sm')}
              >
                <ArrowUp className="size-3.5" strokeWidth={2.5} />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

export default function App() {
  const t = useT();
  const { settings, loading, save } = useSettings();
  const {
    messages,
    isStreaming,
    sendMessage,
    stopAgent,
    threadId,
    threadList,
    hydrated,
    hydrate,
    newChat,
    switchThread,
  } = useAgentSession(settings);
  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ledger = useLedger(threadId);
  const exportTasks = useExportTasks();
  const { needsSignIn } = useHostedAuth(settings);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!loading && !settings) setShowSettings(true);
  }, [loading, settings]);

  useEffect(() => {
    void chrome.storage.session.get('pendingPrompt').then((result) => {
      const pending = result.pendingPrompt as PendingPrompt | undefined;
      if (pending?.selectionText) {
        setInput(t('composer.selectionPrompt', { text: pending.selectionText }));
      }
      void chrome.storage.session.remove('pendingPrompt');
    });
  }, [t]);

  // Escape stops the agent from anywhere in the panel — the composer is
  // disabled while it runs, so a key handler on the textarea would never fire.
  useEffect(() => {
    if (!isStreaming) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopAgent();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isStreaming, stopAgent]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input, messages.length === 0]);

  // Guards Enter as well as the button: the textarea's key handler submits the
  // form directly, so a check that lived only on the button would let the
  // keyboard past it.
  const submit = () => {
    if (!input.trim() || needsSignIn) return;
    void sendMessage(input);
    setInput('');
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const pickSuggestion = (text: string) => {
    void sendMessage(text);
    setInput('');
  };

  if (loading || !hydrated) return <BootSkeleton />;

  // Sending while signed out is a guaranteed failure, so the button says no
  // rather than the turn does. Typing stays open — the notice above the composer
  // is the way out, and disabling the textarea would only hide what was typed.
  const canSend = input.trim().length > 0 && !needsSignIn;
  const isEmpty = messages.length === 0;

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-bg" data-app-shell>
      {/* Withheld until there is something to go back to. On a first run these
          are all controls for a chat that cannot happen yet — new chat, history,
          a settings toggle for the screen already showing — and they turn setup
          into a dialog inside an app rather than the only thing on screen. */}
      {settings && (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface/80 px-3 backdrop-blur-sm">
          <BrandMark size={20} aria-hidden />
          <ThreadSwitcher
            threadId={threadId}
            threadList={threadList}
            isStreaming={isStreaming}
            blocked={showSettings}
            settingsOpen={showSettings}
            onToggleSettings={() => setShowSettings((s) => !s)}
            onNewChat={() => {
              void newChat();
            }}
            onSwitch={(id) => {
              void switchThread(id);
            }}
          />
        </header>
      )}

      {showSettings ? (
        <SettingsPanel initial={settings} onSave={save} onClose={() => setShowSettings(false)} />
      ) : (
        <>
          <BoundTabBar />
          <LedgerPanel ledger={ledger} onSaveTask={(n, e, k) => void exportTasks.save(n, e, k)} />

          {isEmpty ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-3 py-6">
              <EmptyIntro />
              <div className="w-full">
                {/* Also here: re-running a saved task fills the ledger without
                    sending a message, so the thread stays "empty" while holding
                    a finished table. */}
                {ledger && ledger.findings.length > 0 && <ResultBar ledger={ledger} />}
                <Composer
                  input={input}
                  setInput={setInput}
                  inputRef={inputRef}
                  isStreaming={isStreaming}
                  canSend={canSend}
                  needsSignIn={needsSignIn}
                  onSignIn={() => setShowSettings(true)}
                  onSubmit={handleSubmit}
                  onStop={stopAgent}
                />
              </div>
              {/* Hidden rather than inert: a row of one-click prompts that
                  quietly do nothing is a worse answer than not offering them. */}
              {!needsSignIn && <EmptySuggestions onPick={pickSuggestion} />}
              {/* Re-running a saved export needs no model, so it is offered
                  whether or not the account can send a message. */}
              <ExportTaskList
                tasks={exportTasks.tasks}
                runningId={exportTasks.runningId}
                disabled={isStreaming}
                onRun={(task) => void exportTasks.run(task)}
                onDelete={(id) => void exportTasks.remove(id)}
              />
              {exportTasks.outcome && (
                <p
                  role="status"
                  className="w-full max-w-[320px] text-center text-[11px] leading-[1.5] text-fg-tertiary"
                >
                  {t(exportTasks.outcome.key, exportTasks.outcome.vars)}
                </p>
              )}
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ChatThread
                messages={messages}
                isStreaming={isStreaming}
                onSend={(text) => void sendMessage(text)}
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-bg from-40% via-bg/85 to-transparent px-3 pt-10 pb-3">
                <div className="pointer-events-auto w-full">
                  {/* Once there are rows, offering "export this list" again is
                      noise — what is wanted is the result. */}
                  {ledger && ledger.findings.length > 0 ? (
                    <ResultBar ledger={ledger} />
                  ) : (
                    <ExportChip disabled={isStreaming || needsSignIn} onPick={pickSuggestion} />
                  )}
                  <Composer
                    input={input}
                    setInput={setInput}
                    inputRef={inputRef}
                    isStreaming={isStreaming}
                    canSend={canSend}
                    needsSignIn={needsSignIn}
                    onSignIn={() => setShowSettings(true)}
                    onSubmit={handleSubmit}
                    onStop={stopAgent}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
