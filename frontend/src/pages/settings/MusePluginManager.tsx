import {
  CheckCircle2,
  Loader2,
  PackagePlus,
  Power,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MusePluginSummaryView, MusePluginView } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

type Props = {
  onChanged?: () => void | Promise<void>;
  onCount?: (count: number) => void;
};

export function MusePluginManager({ onChanged, onCount }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [summary, setSummary] = useState<MusePluginSummaryView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await agentManagementApi.musePlugins();
      setSummary(next);
      setSelectedId((current) => {
        if (current && next.plugins.some((plugin) => plugin.id === current)) {
          return current;
        }
        return next.plugins[0]?.id ?? null;
      });
    } catch (error) {
      const message = errorMessage(
        error,
        t('settings:agents.musePluginLoadFailed')
      );
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    onCount?.(summary?.plugins.length ?? 0);
  }, [onCount, summary]);

  const install = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = spec.trim();
    if (!next) return;
    setRunning(`install:${next}`);
    try {
      const result = await agentManagementApi.installMusePlugin(next);
      setSummary(result);
      setSelectedId(result.plugins[0]?.id ?? null);
      setSpec('');
      toast.success(t('settings:agents.musePluginAdded', { name: next }));
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.musePluginAddFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  const approve = async (plugin: MusePluginView) => {
    setRunning(`approve:${plugin.id}`);
    try {
      const result = await agentManagementApi.approveMusePlugin(plugin.id);
      setSummary(result);
      toast.success(
        t('settings:agents.musePluginApproved', { name: plugin.name })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.musePluginApproveFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  const toggleEnabled = async (plugin: MusePluginView) => {
    const nextEnabled = !plugin.enabled;
    setRunning(`toggle:${plugin.id}`);
    try {
      const result = await agentManagementApi.setMusePluginEnabled(
        plugin.id,
        nextEnabled
      );
      setSummary(result);
      toast.success(
        t(
          nextEnabled
            ? 'settings:agents.musePluginEnabled'
            : 'settings:agents.musePluginDisabled',
          { name: plugin.name }
        )
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.musePluginToggleFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  const remove = async (plugin: MusePluginView) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.musePluginRemoveTitle', { name: plugin.name }),
      message: t('settings:agents.musePluginRemoveMessage'),
      confirmText: t('settings:agents.musePluginRemoveConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setRunning(`remove:${plugin.id}`);
    try {
      const next = await agentManagementApi.removeMusePlugin(plugin.id);
      setSummary(next);
      setSelectedId(next.plugins[0]?.id ?? null);
      toast.success(
        t('settings:agents.musePluginRemoved', { name: plugin.name })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.musePluginRemoveFailed'))
      );
    } finally {
      setRunning(null);
    }
  };

  const selected = summary?.plugins.find((plugin) => plugin.id === selectedId);

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2 px-4 pb-3"
        onSubmit={(event) => void install(event)}
      >
        <label className="min-w-56 flex-1 space-y-1 text-xs">
          <span>{t('settings:agents.musePluginSpec')}</span>
          <input
            autoComplete="off"
            className="raised-control h-9 w-full px-3"
            disabled={running !== null}
            name="muse_plugin_spec"
            placeholder={t('settings:agents.musePluginSpecPlaceholder')}
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
          />
        </label>
        <Button
          className="h-9"
          disabled={running !== null || !spec.trim()}
          size="sm"
          type="submit"
        >
          {running === `install:${spec.trim()}` ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('settings:agents.musePluginAdd')}
        </Button>
        <Button
          aria-label={t('settings:agents.musePluginRefreshAria')}
          className="h-9"
          disabled={loading || running !== null}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void load()}
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('settings:agents.refresh')}
        </Button>
      </form>

      {loading && !summary ? (
        <p className="agent-plugin-empty">
          {t('settings:agents.musePluginChecking')}
        </p>
      ) : loadError && !summary ? (
        <div className="agent-inline-error" role="alert">
          <span>{loadError}</span>
          <Button
            className="h-8 shrink-0"
            size="sm"
            variant="outline"
            onClick={() => void load()}
          >
            {t('settings:agents.retryRead')}
          </Button>
        </div>
      ) : summary?.plugins.length ? (
        <div className="agent-native-plugin-split">
          <ul aria-label={t('settings:agents.musePluginTitle')}>
            {summary.plugins.map((plugin) => {
              const active = plugin.id === selectedId;
              return (
                <li key={plugin.id}>
                  <button
                    className={`plugin-hub-row${active ? ' is-selected' : ''}`}
                    type="button"
                    onClick={() => setSelectedId(plugin.id)}
                  >
                    <span
                      className={`agent-plugin-status ${
                        plugin.enabled ? 'is-installed' : ''
                      }`}
                    >
                      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                    </span>
                    <strong className="truncate">{plugin.name}</strong>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <article>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Puzzle aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <h4 className="truncate text-sm font-semibold">
                      {selected.name}
                    </h4>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {selected.status}
                    {selected.version ? ` · ${selected.version}` : ''}
                    {selected.marketplace ? ` · ${selected.marketplace}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!selected.approved ? (
                    <Button
                      className="h-8 shrink-0"
                      disabled={running !== null}
                      size="sm"
                      variant="outline"
                      onClick={() => void approve(selected)}
                    >
                      {running === `approve:${selected.id}` ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 animate-spin"
                        />
                      ) : (
                        <ShieldCheck
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                        />
                      )}
                      {t('settings:agents.musePluginApprove')}
                    </Button>
                  ) : null}
                  <Button
                    className="h-8 shrink-0"
                    disabled={running !== null}
                    size="sm"
                    variant="outline"
                    onClick={() => void toggleEnabled(selected)}
                  >
                    {running === `toggle:${selected.id}` ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                      />
                    ) : (
                      <Power aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {selected.enabled
                      ? t('settings:agents.musePluginDisable')
                      : t('settings:agents.musePluginEnable')}
                  </Button>
                  <Button
                    aria-label={t('settings:agents.musePluginRemoveAria', {
                      name: selected.name,
                    })}
                    className="h-8 shrink-0"
                    disabled={running !== null}
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(selected)}
                  >
                    {running === `remove:${selected.id}` ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                      />
                    ) : (
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {t('common:delete')}
                  </Button>
                </div>
              </div>
              {selected.source ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {selected.source}
                </p>
              ) : null}
              {selected.path ? (
                <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                  {selected.path}
                </p>
              ) : null}
            </article>
          ) : null}
        </div>
      ) : (
        <p className="agent-plugin-empty">
          {t('settings:agents.musePluginEmpty')}
        </p>
      )}
    </div>
  );
}
