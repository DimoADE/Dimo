import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Globe,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  hostConnectivityApi,
  type CustomPublicOriginRecord,
  type CustomPublicProbeResult,
} from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';

export function CustomPublicOriginsSection({
  onReachabilityChange,
}: {
  onReachabilityChange?: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [origins, setOrigins] = useState<CustomPublicOriginRecord[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<CustomPublicProbeResult | null>(
    null
  );
  const [supported, setSupported] = useState(true);

  const load = useCallback(async () => {
    try {
      if (typeof hostConnectivityApi?.listCustomPublicOrigins !== 'function') {
        setSupported(false);
        return;
      }
      const list = await hostConnectivityApi.listCustomPublicOrigins();
      setOrigins(Array.isArray(list) ? list : []);
      setSupported(true);
    } catch {
      setSupported(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!supported) {
    return null;
  }

  const handleProbe = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setProbing(true);
    setLastCheck(null);
    try {
      const result = await hostConnectivityApi.probeCustomPublicOrigin(trimmed);
      setLastCheck(result);
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          t('webService.customPublicProbeFailed', '连通性测试失败')
        )
      );
    } finally {
      setProbing(false);
    }
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const result = await hostConnectivityApi.addCustomPublicOrigin({
        origin: trimmed,
        label: labelInput.trim() || undefined,
      });
      setOrigins(result.customPublicOrigins);
      const hasIssue =
        result.check &&
        (!result.check.reachable ||
          !result.check.host_id_matched ||
          Boolean(result.check.warning) ||
          Boolean(result.check.error));
      setLastCheck(hasIssue ? result.check : null);
      setUrlInput('');
      setLabelInput('');
      toast.success(t('webService.customPublicAdded'));
      onReachabilityChange?.();
    } catch (error) {
      toast.error(
        getErrorMessage(error, t('webService.customPublicAddFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      const remaining = await hostConnectivityApi.removeCustomPublicOrigin(id);
      setOrigins(remaining);
      toast.success(t('webService.customPublicRemoved'));
      onReachabilityChange?.();
    } catch (error) {
      toast.error(
        getErrorMessage(error, t('webService.customPublicRemoveFailed'))
      );
    } finally {
      setRemovingId(null);
    }
  };

  const probeHealthy = Boolean(
    lastCheck?.reachable && lastCheck?.host_id_matched
  );

  return (
    <div
      data-testid="custom-public-origins-section"
      className="settings-pairing-block flex flex-col gap-2.5"
    >
      <div className="settings-pairing-addresses__header flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Globe
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span>{t('webService.customPublicTitle')}</span>
          {origins.length > 0 ? (
            <span className="settings-pairing-devices__count">
              {origins.length}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('webService.customPublicHint')}
        </span>
      </div>

      <form
        onSubmit={(event) => void handleAdd(event)}
        className="flex flex-wrap items-center gap-2"
      >
        <Input
          value={urlInput}
          onChange={(event) => {
            setUrlInput(event.target.value);
            setLastCheck(null);
          }}
          placeholder="https://dimo.example.com"
          aria-label={t('webService.customPublicUrlLabel')}
          className="h-8 min-w-0 flex-1 basis-48 font-mono text-xs"
        />
        <Input
          value={labelInput}
          onChange={(event) => setLabelInput(event.target.value)}
          placeholder={t('webService.customPublicLabelPlaceholder')}
          aria-label={t('webService.customPublicLabel')}
          className="h-8 min-w-0 flex-1 basis-28 text-xs sm:w-32 sm:flex-none"
        />
        <Button
          type="button"
          variant="outline"
          className="px-2.5 text-xs"
          disabled={probing || saving || !urlInput.trim()}
          onClick={() => void handleProbe()}
        >
          {probing ? (
            <Loader2
              className="mr-1 h-3.5 w-3.5 animate-spin"
              aria-hidden="true"
            />
          ) : null}
          {t('webService.customPublicProbe')}
        </Button>
        <Button
          type="submit"
          className="px-2.5 text-xs"
          disabled={saving || !urlInput.trim()}
        >
          {saving ? (
            <Loader2
              className="mr-1 h-3.5 w-3.5 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t('common:add')}
        </Button>
      </form>

      {lastCheck ? (
        <div
          role="status"
          aria-live="polite"
          className={
            probeHealthy
              ? 'flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-2 text-xs text-success'
              : 'flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning'
          }
        >
          {probeHealthy ? (
            <CheckCircle2
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <CircleAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 break-words">
            {probeHealthy
              ? t('webService.customPublicProbeMatched')
              : lastCheck.error ||
                lastCheck.warning ||
                t('webService.customPublicProbeUnmatched')}
          </span>
        </div>
      ) : null}

      {origins.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border bg-card">
          {origins.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-foreground">
                  {item.origin}
                </span>
                {item.label ? (
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                    {item.label}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                disabled={removingId === item.id}
                aria-label={t('webService.customPublicRemoveTarget', {
                  origin: item.origin,
                })}
                onClick={() => void handleRemove(item.id)}
              >
                {removingId === item.id ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
