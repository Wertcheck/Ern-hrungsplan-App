import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { Category } from '../domain/types'

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ')

export const CAT_EMOJI: Record<Category, string> = {
  gemuese: '🥦', obst: '🍎', fleisch: '🍗', fisch: '🐟', milch: '🥛', getreide: '🌾', nuesse: '🥜', oele: '🫒', gewuerze: '🌿', getraenke: '🥤', sonstige: '🍯',
}

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <div onClick={onClick} className={cx('rounded-3xl bg-paper/90 border border-sand/70 shadow-[0_2px_14px_rgba(60,70,40,.07)] p-4 sm:p-5', onClick && 'cursor-pointer hover:shadow-md transition-shadow', className)}>{children}</div>
}

export function Btn({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' | 'danger' }) {
  const v = {
    primary: 'bg-forest text-white hover:bg-forest-dark shadow-sm',
    soft: 'bg-moss text-forest-dark hover:bg-[#d6e0bd]',
    ghost: 'bg-transparent text-forest hover:bg-moss/60 border border-sand',
    danger: 'bg-danger text-white hover:opacity-90',
  }[variant]
  return <button {...p} className={cx('inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 font-medium transition disabled:opacity-40 disabled:cursor-not-allowed min-h-11', v, className)} />
}

export function Chip({ active, onClick, children, tone = 'default', title }: { active?: boolean; onClick?: () => void; children: ReactNode; tone?: 'default' | 'danger' | 'warn'; title?: string }) {
  const t = active
    ? tone === 'danger' ? 'bg-danger/10 border-danger text-danger' : 'bg-moss border-forest text-forest-dark'
    : 'bg-paper border-sand text-ink/80 hover:border-olive'
  const Tag = onClick ? 'button' : 'span'
  return <Tag type={onClick ? 'button' : undefined} title={title} onClick={onClick} aria-pressed={onClick ? !!active : undefined}
    className={cx('inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition min-h-9 whitespace-nowrap', t)}>{children}</Tag>
}

export function Field({ label, hint, children, error }: { label: string; hint?: string; children: ReactNode; error?: string }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-muted mt-1">{hint}</span>}
      {error && <span className="block text-xs text-danger mt-1" role="alert">{error}</span>}
    </label>
  )
}
export const inputCls = 'w-full rounded-2xl border border-sand bg-white px-3.5 py-2.5 min-h-11 focus:border-forest outline-none'

export function NumInput({ value, onChange, min, max, step = 1, ...rest }: { value: number | undefined; onChange: (n: number | undefined) => void; min?: number; max?: number; step?: number } & Record<string, unknown>) {
  return <input {...rest} type="number" inputMode="decimal" className={inputCls} value={value ?? ''} min={min} max={max} step={step}
    onChange={e => { const v = e.target.value; onChange(v === '' ? undefined : Number(v)) }} />
}

export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = prev }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40 backdrop-blur-[2px]" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div onClick={e => e.stopPropagation()} className={cx('sheet bg-cream w-full max-h-[92vh] overflow-y-auto rounded-t-[2rem] sm:rounded-[2rem] p-5 sm:p-6 safe-b', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Schließen" className="h-10 w-10 rounded-full bg-moss text-forest-dark text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Ring({ value, max, label, sub }: { value: number; max: number; label: string; sub: string }) {
  const r = 52, c = 2 * Math.PI * r, p = Math.min(1, max ? value / max : 0)
  return (
    <svg viewBox="0 0 130 130" className="w-36 h-36" role="img" aria-label={`${label} ${sub}`}>
      <circle cx="65" cy="65" r={r} fill="none" stroke="#e3ead2" strokeWidth="12" />
      <circle cx="65" cy="65" r={r} fill="none" stroke="#2f5d2a" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 65 65)" style={{ transition: 'stroke-dasharray .6s ease' }} />
      <text x="65" y="63" textAnchor="middle" fontSize="22" fontWeight="700" fill="#1d2b1a" fontFamily="Georgia, serif">{label}</text>
      <text x="65" y="82" textAnchor="middle" fontSize="10" fill="#6b705f">{sub}</text>
    </svg>
  )
}

export function Bar({ label, value, max, color, unit = 'g' }: { label: string; value: number; max: number; color: string; unit?: string }) {
  const p = max ? Math.min(100, (value / max) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-sm"><span className="font-medium">{label}</span><span className="text-muted">{Math.round(value)} {unit} / {Math.round(max)} {unit}</span></div>
      <div className="h-2.5 rounded-full bg-sand/60 mt-1 overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${p}%`, background: color }} /></div>
    </div>
  )
}

export function PageTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 mb-5 rise">
      <div><h1 className="text-3xl sm:text-4xl font-semibold text-forest-dark">{title}</h1>{sub && <p className="text-muted mt-1">{sub}</p>}</div>
      {right}
    </div>
  )
}

export function Notice({ level, children }: { level: 'error' | 'warn' | 'info'; children: ReactNode }) {
  const t = { error: 'bg-danger/10 border-danger/40 text-danger', warn: 'bg-[#fbeedd] border-warn/40 text-warn', info: 'bg-moss/60 border-olive/40 text-forest-dark' }[level]
  return <div role={level === 'error' ? 'alert' : undefined} className={cx('rounded-2xl border px-4 py-3 text-sm', t)}>{children}</div>
}

export const fmt = (n: number, d = 0) => n.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d })
export const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) }
export const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
export const WEEKDAYS_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
export const parseISO = (iso: string) => new Date(iso + 'T00:00:00')
export const dateLabel = (iso: string) => parseISO(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
