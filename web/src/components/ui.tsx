import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type HealthStatus, type Severity } from '../api';

export function SeverityBadge({ s }: { s: Severity }) {
  return <span className={`badge sev-${s.toLowerCase()}`}>{s}</span>;
}

export function Counts({ high, medium, low }: { high: number; medium: number; low: number }) {
  return (
    <span className="counts" aria-label={`${high} high, ${medium} medium, ${low} low`}>
      <span className={`count sev-high ${high ? '' : 'zero'}`}>{high} high</span>
      <span className={`count sev-medium ${medium ? '' : 'zero'}`}>{medium} med</span>
      <span className={`count sev-low ${low ? '' : 'zero'}`}>{low} low</span>
    </span>
  );
}

export function StatusPill({ status }: { status: 'running' | 'finished' }) {
  return (
    <span className={`pill ${status}`}>
      {status === 'running' && <span className="pulse" aria-hidden="true" />}
      {status === 'running' ? 'running' : 'finished'}
    </span>
  );
}

const HEALTH: Record<HealthStatus, { label: string; icon: string }> = {
  passing: { label: 'Passing', icon: '✓' },
  warning: { label: 'Needs attention', icon: '!' },
  failing: { label: 'Failing', icon: '✕' },
  no_runs: { label: 'No runs yet', icon: '–' },
};

/** Health of a project's latest run; icon + label, never colour alone. */
export function HealthBadge({ status }: { status: HealthStatus }) {
  const h = HEALTH[status];
  return (
    <span className={`health health-${status}`}>
      <span className="health-icon" aria-hidden="true">
        {h.icon}
      </span>
      {h.label}
    </span>
  );
}

export function healthOf(c: { high: number; medium: number } | null | undefined): HealthStatus {
  if (!c) return 'no_runs';
  return c.high > 0 ? 'failing' : c.medium > 0 ? 'warning' : 'passing';
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const e = error as Error;
  return (
    <div className="error" role="alert">
      <div className="error-body">
        <strong>
          {e instanceof ApiError && e.status === 401
            ? 'This dashboard needs an admin token.'
            : e instanceof ApiError && e.status === 404
              ? 'Not found.'
              : 'Something went wrong.'}
        </strong>{' '}
        {e instanceof ApiError && e.status === 401 ? 'Set it with the key button in the top bar.' : e.message}
        {e instanceof ApiError && e.issues.length > 0 && (
          <ul>
            {e.issues.map((i) => (
              <li key={i.path + i.message}>
                <code>{i.path || '(root)'}</code>: {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {onRetry && (
        <button className="secondary small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {title && <p className="empty-title">{title}</p>}
      <div className="empty-body">{children}</div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  description,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id}>
      <header className="card-head">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p className="card-desc">{description}</p>}
        </div>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Placeholder rows while data loads, so the layout doesn't jump. */
export function Skeleton({ rows = 3, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-line" style={{ height, width: `${92 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}

export function Crumbs({ items }: { items: { to?: string; label: ReactNode }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((it, i) => (
          <li key={i}>
            {it.to ? <Link to={it.to}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** Copies text to the clipboard and says so. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary small"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {},
        );
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

// ---- confirmation dialog ------------------------------------------------

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  /** When set, the user must type this to enable the confirm button. */
  typeToConfirm?: string;
}

/**
 * A modal for destructive actions. Focus moves into it, Escape cancels, Tab
 * stays inside, and focus returns to the trigger when it closes.
 */
export function ConfirmDialog({
  open,
  options,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  options: ConfirmOptions;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    setTyped('');
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => prev?.focus?.();
  }, [open]);
  if (!open) return null;
  const blocked = !!options.typeToConfirm && typed !== options.typeToConfirm;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={ref}
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onCancel();
          if (e.key === 'Tab') {
            const els = [...(ref.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])];
            const i = els.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && i <= 0) {
              e.preventDefault();
              els[els.length - 1]?.focus();
            } else if (!e.shiftKey && i === els.length - 1) {
              e.preventDefault();
              els[0]?.focus();
            }
          }
        }}
      >
        <h2 id={titleId}>{options.title}</h2>
        <div className="modal-body">{options.body}</div>
        {options.typeToConfirm && (
          <label className="field">
            <span>
              Type <code>{options.typeToConfirm}</code> to confirm
            </span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={options.danger ? 'danger-solid' : ''} onClick={onConfirm} disabled={busy || blocked}>
            {busy ? 'Working…' : options.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Hook form of ConfirmDialog: `ask(options, action)`, and render `dialog`. */
export function useConfirm() {
  const [state, setState] = useState<{ options: ConfirmOptions; action: () => Promise<unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ask = useCallback((options: ConfirmOptions, action: () => Promise<unknown>) => setState({ options, action }), []);
  const dialog = (
    <ConfirmDialog
      open={!!state}
      busy={busy}
      options={state?.options ?? { title: '', body: null, confirm: '' }}
      onCancel={() => setState(null)}
      onConfirm={() => {
        if (!state) return;
        setBusy(true);
        state
          .action()
          .then(() => setState(null))
          .catch((e: Error) => toast(e.message, 'error'))
          .finally(() => setBusy(false));
      }}
    />
  );
  return { ask, dialog };
}

// ---- toasts --------------------------------------------------------------

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, kind: ToastKind = 'success') => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-3), { id, text, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon" aria-hidden="true">
              {t.kind === 'success' ? '✓' : t.kind === 'error' ? '✕' : 'i'}
            </span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
