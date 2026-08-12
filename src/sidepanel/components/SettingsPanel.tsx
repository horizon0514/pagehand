import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Languages, Search, Sparkles, X } from 'lucide-react';
import {
  Settings,
  ProviderId,
  ByokProviderId,
  DEFAULT_BYOK_PROVIDER,
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  DEEPSEEK_BASE_URL,
  HOSTED_BASE_URL,
  HOSTED_MODELS,
  isHosted,
} from '../../lib/storage/schema';
import type { LocalePreference } from '../../lib/i18n';
import { useI18n } from '../i18n/useT';
import { useSignIn } from '../hooks/useSignIn';
import { AccountRow } from './AccountRow';
import { SignInView } from './SignInView';
import { Label, SectionLabel } from './ui/label';
import { Input } from './ui/input';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectIconTrigger,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { cn } from '../lib/utils';

/** Kept in sync with `host_permissions` in manifest.config.ts — origins listed
 * there are already granted, so asking again would raise a needless dialog. */
const DEFAULT_HOST_ORIGINS = new Set([
  'https://pagehand.app',
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://api.deepseek.com',
  'https://www.bing.com',
  'https://cn.bing.com',
  'https://api.firecrawl.dev',
]);

interface Props {
  initial: Settings | null;
  onSave: (settings: Settings) => Promise<void>;
  onClose: () => void;
}

async function ensureHostPermission(
  baseURL: string | undefined,
  denyMessage: (origin: string) => string,
): Promise<void> {
  if (!baseURL) return;
  const origin = new URL(baseURL).origin;
  if (DEFAULT_HOST_ORIGINS.has(origin)) return;

  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new Error(denyMessage(origin));
}

/**
 * Language, demoted to an icon.
 *
 * It is changed roughly once, by roughly nobody, and as a labelled full-width
 * row it carried the same weight as the thing the panel exists for. The icon
 * keeps it one click away and stops it competing.
 */
function LanguageSelect() {
  const { t, preference, setPreference } = useI18n();
  return (
    <Select value={preference} onValueChange={(v) => void setPreference(v as LocalePreference)}>
      <SelectIconTrigger aria-label={t('settings.language')} title={t('settings.language')}>
        <Languages className="size-3.5" />
      </SelectIconTrigger>
      <SelectContent align="end" className="w-auto min-w-[9rem]">
        <SelectItem value="system">{t('settings.language.system')}</SelectItem>
        <SelectItem value="en">{t('settings.language.en')}</SelectItem>
        <SelectItem value="zh">{t('settings.language.zh')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClose}
      aria-label={t('settings.close')}
      title={t('settings.close')}
    >
      <X className="size-3.5" />
    </Button>
  );
}

/** The eye on a secret field. Two fields hold keys now, and neither should be
 * the one that renders the toggle differently. */
function RevealToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-tertiary outline-none transition-colors duration-200 hover:bg-surface-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-line"
      aria-label={shown ? t('settings.hideKey') : t('settings.showKey')}
      title={shown ? t('settings.hideKey') : t('settings.showKey')}
    >
      {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
    </button>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  badge,
  trailing,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  badge?: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex min-h-4 items-center gap-1.5">
        <Label htmlFor={htmlFor} className="min-w-0 flex-1 truncate">
          {label}
        </Label>
        {badge && (
          <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium tracking-[0.02em] text-fg-tertiary ring-1 ring-line">
            {badge}
          </span>
        )}
        {trailing}
      </div>
      {children}
      {hint && <p className="text-[11px] leading-[1.4] text-fg-tertiary">{hint}</p>}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-0.5">
        <Icon className="size-3 text-fg-tertiary" aria-hidden />
        <SectionLabel className="px-0">{title}</SectionLabel>
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_0_rgba(15,23,42,0.03)]">
        {children}
      </div>
    </section>
  );
}

export default function SettingsPanel({ initial, onSave, onClose }: Props) {
  const { t } = useI18n();
  const firstRun = initial == null;
  const [provider, setProvider] = useState<ProviderId>(initial?.provider ?? DEFAULT_PROVIDER);
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODELS[DEFAULT_BYOK_PROVIDER]);
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? '');
  const [firecrawlApiKey, setFirecrawlApiKey] = useState(initial?.firecrawlApiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [showSearchKey, setShowSearchKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hosted = isHosted(provider);
  const [lastByokProvider, setLastByokProvider] = useState<ByokProviderId>(
    initial && !isHosted(initial.provider)
      ? (initial.provider as ByokProviderId)
      : DEFAULT_BYOK_PROVIDER,
  );
  useEffect(() => {
    if (!hosted) setLastByokProvider(provider as ByokProviderId);
  }, [hosted, provider]);

  // Settings saved before the catalogue changed — or carried over from a BYOK
  // provider — would otherwise render the select blank and save an id the
  // server will reject.
  const hostedModel = (HOSTED_MODELS as readonly string[]).includes(model)
    ? model
    : HOSTED_MODELS[0];

  const handleProviderChange = (next: ProviderId) => {
    setProvider(next);
    if (!initial || initial.provider !== next) setModel(DEFAULT_MODELS[next]);
  };

  /**
   * Hosted is the path; BYOK is the way off it. Deliberately not a picker of
   * two peers — a select said "these are equally the product", which is the
   * opposite of true. Remembering the last BYOK provider means leaving and
   * coming back doesn't silently reset someone's setup.
   */
  const handleModeChange = (next: 'hosted' | 'byok') => {
    if (next === 'hosted') handleProviderChange('hosted');
    else handleProviderChange(lastByokProvider);
  };

  /** Hosted has no other input, so signing in *is* completing setup. Persisted
   * without closing the panel: the user still sees the result of what they did. */
  const persistHosted = useCallback(() => {
    // Carries the search key through: it belongs to no provider, so signing in
    // must not quietly drop one the user already entered.
    void onSave({
      provider: 'hosted',
      model: HOSTED_MODELS[0],
      firecrawlApiKey: firecrawlApiKey.trim() || undefined,
    });
  }, [onSave, firecrawlApiKey]);

  const signIn = useSignIn(persistHosted);
  const signedIn = signIn.session !== null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // Hosted stores no base URL of its own — providers.ts reads the constant.
      // Dropping it also clears anything a previous BYOK setup left behind,
      // which would otherwise silently redirect hosted traffic.
      const trimmedBaseURL = hosted ? undefined : baseURL.trim() || undefined;
      await ensureHostPermission(trimmedBaseURL ?? (hosted ? HOSTED_BASE_URL : undefined), (origin) =>
        t('settings.permissionDenied', { origin }),
      );
      await onSave({
        provider,
        // Hosted has no user-held key; storing an empty string would only make
        // the settings look half-filled to anything that reads them later.
        apiKey: hosted ? undefined : apiKey.trim(),
        model: hosted ? hostedModel : model.trim(),
        baseURL: trimmedBaseURL,
        firecrawlApiKey: firecrawlApiKey.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Hosted is complete when there's an account; BYOK when there's a key. The
  // old condition asked for a key either way, which left hosted staring at a
  // button it could never enable.
  const canSubmit = hosted ? signedIn : Boolean(apiKey.trim() && model.trim());

  const baseUrlHint =
    provider === 'deepseek'
      ? t('settings.baseUrlHint.deepseek', { url: DEEPSEEK_BASE_URL })
      : provider === 'openai'
        ? t('settings.baseUrlHint.openai')
        : t('settings.baseUrlHint.other');

  // Hosted with no account isn't a settings screen with a field left blank —
  // it's a sign-in screen, and drawing it as anything else was the whole
  // problem. Held back until the stored session has actually been read, so a
  // signed-in user never sees it flash.
  if (hosted && !signIn.loading && !signedIn) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Floated rather than given a title bar of their own: a whole toolbar
            holding one icon reads as a mistake, and a sign-in screen with two
            stacked chrome bars above it reads as a form buried in an app. */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <LanguageSelect />
          {!firstRun && <CloseButton onClose={onClose} />}
        </div>
        <SignInView signIn={signIn} onUseOwnKey={() => handleModeChange('byok')} />
      </div>
    );
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface/80 px-3 backdrop-blur-sm">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.015em] text-fg">
          {t('settings.title')}
        </h2>
        <LanguageSelect />
        {!firstRun && <CloseButton onClose={onClose} />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-3 pb-4">
        {/* Hosted's only input is an account. The model comes from the plan and
            the endpoint is ours — exposing either would only be a way to get
            them wrong. When plans offer a choice of models (PLAN-subscription
            §7 Phase 4), that picker belongs here. */}
        {hosted && (
          <Section icon={Sparkles} title={t('settings.hosted')}>
            <AccountRow signIn={signIn} />
          </Section>
        )}

        {!hosted && (
          <Section icon={KeyRound} title={t('settings.sectionByok')}>
            <Field label={t('settings.provider')} htmlFor="provider">
              <Select value={provider} onValueChange={(v) => handleProviderChange(v as ProviderId)}>
                <SelectTrigger id="provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field
              label={t('settings.apiKey')}
              hint={t('settings.apiKeyHint')}
              htmlFor="apiKey"
              trailing={<RevealToggle shown={showKey} onToggle={() => setShowKey((v) => !v)} />}
            >
              <Input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                className="font-mono text-[12px] tracking-tight"
              />
            </Field>

            <Field label={t('settings.model')} htmlFor="model">
              <Input
                id="model"
                type="text"
                spellCheck={false}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                required
                className="font-mono text-[12px] tracking-tight"
              />
            </Field>

            <Field
              label={t('settings.baseUrlOptional')}
              badge={provider === 'openai-compatible' ? undefined : t('settings.optional')}
              hint={baseUrlHint}
              htmlFor="baseURL"
            >
              <Input
                id="baseURL"
                type="url"
                spellCheck={false}
                placeholder={provider === 'deepseek' ? DEEPSEEK_BASE_URL : 'https://…'}
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                className="font-mono text-[12px] tracking-tight"
              />
            </Field>
          </Section>
        )}

        {/* Its own section, below whichever provider section is showing,
            because search is not part of either: the model vendor and the
            search vendor are different companies, and leaving this blank costs
            the user nothing but a slightly noisier ladder. */}
        <Section icon={Search} title={t('settings.sectionSearch')}>
          <Field
            label={t('settings.searchKey')}
            hint={t('settings.searchKeyHint')}
            htmlFor="firecrawlApiKey"
            badge={t('settings.optional')}
            trailing={
              <RevealToggle shown={showSearchKey} onToggle={() => setShowSearchKey((v) => !v)} />
            }
          >
            <Input
              id="firecrawlApiKey"
              type={showSearchKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="fc-…"
              value={firecrawlApiKey}
              onChange={(e) => setFirecrawlApiKey(e.target.value)}
              className="font-mono text-[12px] tracking-tight"
            />
          </Field>
        </Section>

        {/* A link, not a segmented control: the way back to the main path, and
            the way off it, should both cost one click and neither should look
            like half the product. */}
        <button
          type="button"
          onClick={() => handleModeChange(hosted ? 'byok' : 'hosted')}
          className="cursor-pointer self-start px-0.5 text-[11px] text-fg-tertiary underline underline-offset-2 transition-colors duration-200 hover:text-fg-secondary"
        >
          {t(hosted ? 'settings.switchToByok' : 'settings.switchToHosted')}
        </button>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-negative-line bg-negative-soft px-2.5 py-2 text-[11.5px] leading-[1.45] text-negative"
          >
            {error}
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-t border-line bg-surface/90 px-3 py-2.5 backdrop-blur-sm',
          firstRun && 'pb-3',
        )}
      >
        <Button type="submit" disabled={saving || !canSubmit} className="min-w-[72px]">
          {saving ? t('settings.saving') : hosted ? t('settings.done') : t('settings.save')}
        </Button>
        {!firstRun && (
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
