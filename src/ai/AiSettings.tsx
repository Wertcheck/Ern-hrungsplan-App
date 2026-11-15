import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { Btn, Card, Chip, Field, Notice, NumInput, fmt, inputCls } from '../ui/kit'
import { useAi } from './AiProvider'
import type { AiSettings as Settings, ModelList, ProviderName } from './types'

const PROVIDERS: { id: ProviderName; label: string }[] = [{ id: 'anthropic', label: 'Claude (Anthropic)' }, { id: 'openai', label: 'OpenAI' }]
const NO_SAMPLING = /^claude-(fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[6-9]|sonnet-4-6)|^(o\d|gpt-5)/

/** KI-Einstellungen: Anbieter, Modell, Limits, Kosten, Verbindungstest, Datenfreigaben. Schlüssel werden hier nie angezeigt oder eingegeben. */
export function AiSettingsCard() {
  const { state, update } = useStore()
  const ai = useAi()
  const [s, setS] = useState<Settings | null>(null)
  const [models, setModels] = useState<Record<string, ModelList | undefined>>({})
  const [msg, setMsg] = useState<{ level: 'info' | 'error' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const reachable = !!ai.status

  const load = useCallback(async () => { try { setS(await ai.client.getSettings()) } catch { setS(null) } }, [ai.client])
  useEffect(() => { void load() }, [load, ai.status?.enabled])
  const save = async (patch: Parameters<typeof ai.client.updateSettings>[0]) => {
    try { setS(await ai.client.updateSettings(patch)); await ai.refreshStatus(); setMsg(null) } catch (e) { setMsg({ level: 'error', text: (e as Error).message }) }
  }
  const loadModels = async (p: 'openai' | 'anthropic') => { setBusy(true); try { setModels(m => ({ ...m, [p]: undefined })); setModels(m => ({ ...m, [p]: undefined })); const r = await ai.client.models(p); setModels(m => ({ ...m, [p]: r })) } catch (e) { setMsg({ level: 'error', text: (e as Error).message }) } finally { setBusy(false) } }
  const test = async () => { if (!s) return; setBusy(true); try { const r = await ai.client.test(s.provider); setMsg({ level: r.ok ? 'info' : 'error', text: r.ok ? `Verbindung zu ${s.provider} OK (${r.latency_ms} ms).` : `Verbindung fehlgeschlagen: ${r.detail ?? 'unbekannt'}` }) } catch (e) { setMsg({ level: 'error', text: (e as Error).message }) } finally { setBusy(false) } }
  const share = state.ai.share
  const setShare = (k: keyof typeof share) => update(st => ({ ...st, ai: { ...st.ai, share: { ...st.ai.share, [k]: !st.ai.share[k] } } }))
  const st = ai.status
  const model = s ? s.models[s.provider === 'mock' ? 'anthropic' : s.provider] : null
  const list = s && s.provider !== 'mock' ? models[s.provider] : undefined

  return (
    <Card>
      <h2 className="text-2xl mb-1">KI-Ernährungsberater</h2>
      <p className="text-sm text-muted mb-3">Optional. Die App funktioniert vollständig ohne KI. Die Kommunikation läuft ausschließlich über dein lokales Backend; API-Schlüssel stehen nur dort in der <code>.env</code> und werden nie an die Oberfläche geliefert.</p>
      {ai.statusError && <Notice level="warn">{ai.statusError.message} Starten mit <code>python -m backend</code>.</Notice>}
      {reachable && s && (
        <div className="space-y-4 mt-3">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={s.enabled} onChange={e => void save({ enabled: e.target.checked })} /> KI aktivieren</label>
          <div>
            <p className="text-sm font-medium mb-1">Anbieter</p>
            <div className="flex flex-wrap gap-2">{PROVIDERS.map(p => <Chip key={p.id} active={s.provider === p.id} onClick={() => void save({ provider: p.id })}>{p.label}{st && !st.providers[p.id]?.configured ? ' · Schlüssel fehlt' : ''}</Chip>)}{st?.providers.mock?.configured && <Chip active={s.provider === 'mock'} onClick={() => void save({ provider: 'mock' })}>Test-Anbieter</Chip>}</div>
            {st && s.provider !== 'mock' && !st.providers[s.provider]?.configured && <div className="mt-2"><Notice level="warn">Für diesen Anbieter ist im Backend kein Schlüssel hinterlegt. Trage ihn lokal in die <code>.env</code> ein ({s.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}) und starte das Backend neu. <code>python -m backend.check_env</code> prüft, ohne Werte anzuzeigen.</Notice></div>}
          </div>
          {s.provider !== 'mock' && (
            <div className="space-y-2">
              <Field label={`Modell (${s.provider === 'openai' ? 'OpenAI' : 'Claude'})`} hint="Modell-IDs ändern sich; die Liste wird live vom Anbieter geladen, alternativ kannst du eine ID eintragen.">
                <div className="flex gap-2">
                  {list && list.models.length ? (
                    <select className={inputCls} value={model ?? ''} onChange={e => void save({ models: { [s.provider]: e.target.value || null } })}>
                      <option value="">– bitte wählen –</option>{model && !list.models.some(m => m.id === model) && <option value={model}>{model}</option>}
                      {list.models.map(m => <option key={m.id} value={m.id}>{m.display_name ? `${m.display_name} (${m.id})` : m.id}</option>)}
                    </select>
                  ) : <input className={inputCls} defaultValue={model ?? ''} placeholder="Modell-ID" onBlur={e => { if (e.target.value !== (model ?? '')) void save({ models: { [s.provider]: e.target.value.trim() || null } }) }} />}
                  <Btn variant="soft" disabled={busy} onClick={() => void loadModels(s.provider as 'openai' | 'anthropic')}>Liste laden</Btn>
                </div>
              </Field>
              {list?.source === 'configured' && <p className="text-xs text-muted">Live-Liste nicht verfügbar{list.error ? `: ${list.error}` : ''}. Angezeigt werden nur konfigurierte Modelle.</p>}
              {st?.needs_model && <p className="text-xs text-warn">Es ist noch kein Modell gewählt.</p>}
            </div>
          )}
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Antwortlänge (max. Tokens)" hint={st ? `bis ${st.limits.max_output_tokens_cap}` : undefined}><NumInput value={s.max_output_tokens} min={64} max={st?.limits.max_output_tokens_cap ?? 4096} step={64} onChange={v => v && void save({ max_output_tokens: v })} /></Field>
            <Field label="Verlauf (Nachrichten)" hint="Begrenzt die gesendete Gesprächshistorie"><NumInput value={s.history_messages} min={2} max={st?.limits.max_history_cap ?? 30} onChange={v => v && void save({ history_messages: v })} /></Field>
            <Field label="Temperatur (optional)" hint={model && NO_SAMPLING.test(model) ? 'Von diesem Modell nicht unterstützt – wird ignoriert.' : '0–2; leer = Standard'}><NumInput value={s.temperature ?? undefined} min={0} max={2} step={0.1} onChange={v => void save({ temperature: v ?? null })} /></Field>
          </div>
          <div className="rounded-2xl bg-moss/40 p-3 space-y-2">
            <p className="font-medium text-sm">Kosten und Limit</p>
            {st && <p className="text-sm">Verbrauch {st.usage.month}: {fmt(st.usage.requests)} Anfragen, {fmt(st.usage.input_tokens)} Eingabe-/{fmt(st.usage.output_tokens)} Ausgabe-Tokens · {st.usage.cost_known && st.usage.cost_usd !== null ? `≈ ${fmt(st.usage.cost_usd, 4)} USD` : 'Kosten nicht berechenbar (kein Preis für dieses Modell hinterlegt)'}</p>}
            <div className="grid sm:grid-cols-2 gap-3 items-end">
              <Field label="Monatliches Kostenlimit (USD, optional)"><NumInput value={s.monthly_limit_usd ?? undefined} min={0} step={1} onChange={v => void save({ monthly_limit_usd: v ?? null })} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={s.block_on_limit} onChange={e => void save({ block_on_limit: e.target.checked })} /> Weitere Anfragen bei Limit sperren</label>
            </div>
            {st?.usage.limit_reached && <Notice level="warn">Das monatliche Limit ist erreicht – es antwortet der lokale Berater.</Notice>}
            <p className="text-xs text-muted">Kosten sind Schätzungen aus Token-Zahlen und der lokal gepflegten Preisliste (<code>backend/config/pricing.json</code>); ohne hinterlegten Preis wird nichts erfunden.</p>
          </div>
          <div className="rounded-2xl bg-white/70 border border-sand/70 p-3 space-y-2">
            <p className="font-medium text-sm">Ersatzanbieter</p>
            <div className="flex flex-wrap gap-2 items-center">
              <select aria-label="Ersatzanbieter" className="rounded-full border border-sand bg-paper px-3 py-2 text-sm" value={s.fallback_provider ?? ''} onChange={e => void save({ fallback_provider: (e.target.value || null) as Settings['fallback_provider'] })}>
                <option value="">keiner</option><option value="anthropic">Claude</option><option value="openai">OpenAI</option>
              </select>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={s.auto_fallback} disabled={!s.fallback_provider} onChange={e => void save({ auto_fallback: e.target.checked })} /> automatisch wechseln, wenn der Hauptanbieter ausfällt</label>
            </div>
            <p className="text-xs text-muted">Ohne diese Einstellung wird nie automatisch gewechselt. In jeder Antwort steht, welcher Anbieter sie erzeugt hat.</p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Btn variant="soft" disabled={busy} onClick={() => void test()}>Verbindung testen</Btn>
            {st && <span className="text-sm text-muted">Status: {st.enabled ? 'aktiv' : 'aus'} · {st.providers[s.provider]?.configured ? 'Schlüssel vorhanden' : 'kein Schlüssel'}{st.model ? ` · ${st.model}` : ''}</span>}
          </div>
        </div>
      )}
      {msg && <div className="mt-3"><Notice level={msg.level}>{msg.text}</Notice></div>}

      <div className="mt-5 border-t border-sand/70 pt-4 space-y-2">
        <p className="font-medium">Datenfreigabe für die KI</p>
        <p className="text-xs text-muted">Immer gesendet, damit die KI keine unzulässigen Vorschläge macht: Ernährungsweisen, Allergien/Unverträglichkeiten, Ausschlüsse, Kalorien- und Makroziel. Alles Weitere nur, wenn freigegeben <i>und</i> für die Frage nötig. Im Chat zeigt „Daten“ den genauen Inhalt.</p>
        {([['plan', 'Ernährungsplan-Ausschnitt und zulässige Rezepte'], ['foodPrefs', 'Lebensmittelpräferenzen und Öle'], ['body', 'Alter, Größe, Gewicht (nur bei Kalorien-/Gewichtsfragen)'], ['shopping', 'Einkaufsliste'], ['progress', 'Gewichtsverlauf']] as const).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={share[k]} onChange={() => setShare(k)} /> {l}</label>
        ))}
        <label className="flex items-center gap-2 text-sm font-medium pt-1"><input type="checkbox" className="h-5 w-5 accent-[#2f5d2a]" checked={state.ai.consent} onChange={e => update(x => ({ ...x, ai: { ...x.ai, consent: e.target.checked } }))} /> Ich bin mit der Übertragung an den gewählten Anbieter einverstanden</label>
        <div className="flex gap-2 pt-1"><Btn variant="ghost" onClick={() => { if (confirm('Gesamten Chatverlauf löschen?')) ai.clearAll() }}>Chatverlauf löschen</Btn></div>
      </div>
    </Card>
  )
}
