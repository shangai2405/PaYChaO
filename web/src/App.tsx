import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { adminToken, setAdminToken } from './api';
import { Compare } from './pages/Compare';
import { Guides } from './pages/Guides';
import { Project } from './pages/Project';
import { Projects } from './pages/Projects';
import { RunPage } from './pages/RunPage';
import { Scenarios } from './pages/Scenarios';
import { Empty } from './components/ui';
import { Icon } from './components/Icon';

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'paychaos.theme';

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage blocked: the choice lasts for this page */
    }
  }, [theme]);
  const cycle = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'));
  return [theme, cycle];
}

function AdminToken() {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(adminToken());
  const set = !!adminToken();
  if (!open) {
    return (
      <button className="nav-btn" onClick={() => setOpen(true)} aria-label={set ? 'Admin token set; change it' : 'Set admin token'}>
        <Icon name="key" />
        <span className="nav-label">{set ? 'Admin token set' : 'Admin token'}</span>
      </button>
    );
  }
  return (
    <form
      className="token-form"
      onSubmit={(e) => {
        e.preventDefault();
        setAdminToken(v.trim());
        window.location.reload();
      }}
    >
      <input
        type="password"
        aria-label="Admin token"
        placeholder="only if the API sets ADMIN_TOKEN"
        value={v}
        onChange={(e) => setV(e.target.value)}
        autoFocus
      />
      <div className="row">
        <button type="submit" className="small">
          Save
        </button>
        <button type="button" className="secondary small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NotFound() {
  return (
    <Empty title="Page not found" action={<Link className="button" to="/">Back to projects</Link>}>
      The page you followed doesn't exist, or the run or project was deleted.
    </Empty>
  );
}

export function App() {
  const [theme, cycleTheme] = useTheme();
  const loc = useLocation();
  // Move focus to the page on navigation so screen readers announce it.
  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    // A #fragment means the page scrolls itself to that section.
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="side">
        <Link to="/" className="brand" aria-label="paychaos home">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path d="M4 17 L9 7 L13 14 L16 9 L20 17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-text">
            paychaos
            <small>PayPal chaos testing</small>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive || loc.pathname.startsWith('/projects') || loc.pathname.startsWith('/runs') ? 'active' : ''}`}>
            <Icon name="projects" />
            <span className="nav-label">Projects</span>
          </NavLink>
          <NavLink to="/guides" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="guides" />
            <span className="nav-label">Fix guides</span>
          </NavLink>
        </nav>
        <div className="side-foot">
          <AdminToken />
          <button className="nav-btn" onClick={cycleTheme} aria-label={`Theme: ${theme}. Change theme`}>
            <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'system'} />
            <span className="nav-label">Theme: {theme}</span>
          </button>
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/projects/:id" element={<Project />} />
          <Route path="/projects/:id/scenarios" element={<Scenarios />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/guides" element={<Guides />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
