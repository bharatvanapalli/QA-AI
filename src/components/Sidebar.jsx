import React, { memo, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PlayCircle,
  FileText,
  Terminal,
  BarChart3,
  AlertCircle,
  ShieldCheck,
  Database,
  Brain,
  Files,
  Bot,
  Settings as SettingsIcon,
  User,
  LogOut,
  Sparkles,
  X,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useAuth } from '../store/auth';
import { useRunStream } from '../store/runStream';
import { useToast } from '../lib/useToast';

const PRIMARY = [
  { to: '/overview', label: 'Overview', icon: LayoutDashboard },
  { to: '/run-suite', label: 'Run Suite', icon: PlayCircle },
  { to: '/test-cases', label: 'Test Cases', icon: FileText },
  { to: '/live-pipeline', label: 'Live Pipeline', icon: Bot, liveBadge: true },
  { to: '/project-setup', label: 'Project Setup', icon: Database },
];

const RESULTS = [
  { to: '/execution-log', label: 'Execution Log', icon: Terminal },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/blocked-items', label: 'Blocked', icon: AlertCircle },
  { to: '/governance', label: 'Governance', icon: ShieldCheck },
];

const KNOWLEDGE = [
  { to: '/knowledge-base', label: 'Knowledge Base', icon: Brain },
  { to: '/output-files', label: 'Output Files', icon: Files },
];

function SectionLabel({ children, id, collapsed }) {
  if (collapsed) {
    return (
      <li
        id={id}
        role="presentation"
        aria-hidden="true"
        className="mx-3 mt-5 mb-2 border-t border-white/10"
      />
    );
  }
  return (
    <li
      id={id}
      role="presentation"
      className="px-3 pt-5 pb-2 text-2xs uppercase tracking-[0.18em] font-semibold text-ink-400"
    >
      {children}
    </li>
  );
}

// NavItem is memoised so re-renders in the layout above don't cascade into
// every nav row — each row only re-renders when its own props change. The
// `onNavigate` callback (used by the mobile drawer to auto-close after a
// click) is expected to be referentially stable from the parent.
const NavItem = memo(function NavItem({
  to,
  label,
  icon: Icon,
  liveBadge,
  showBadge,
  onNavigate,
  collapsed,
}) {
  return (
    <li>
      <NavLink
        to={to}
        onClick={onNavigate}
        title={collapsed ? label : undefined}
        // NavLink already sets aria-current="page" when the route matches, so
        // screen readers announce the active item. We also expose a clean
        // focus-visible ring for keyboard users. The relative positioning
        // anchors the collapsed-mode live indicator dot.
        className={({ isActive }) =>
          `relative flex items-center ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-3'} py-2 rounded-md text-sm font-medium transition-all duration-150 ease-out-soft mx-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70
            ${isActive
              ? 'bg-white/10 text-white shadow-[inset_2px_0_0_0_rgb(16,185,129)]'
              : 'text-ink-300 hover:bg-white/5 hover:text-white'}`
        }
      >
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        {!collapsed && <span className="truncate flex-1">{label}</span>}
        {!collapsed && liveBadge && showBadge && (
          <span
            className="text-2xs uppercase tracking-wider font-bold text-success-300 bg-success-500/15 px-1.5 py-0.5 rounded animate-pulse"
            aria-label="Run in progress"
          >
            live
          </span>
        )}
        {collapsed && liveBadge && showBadge && (
          <span
            className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-success-400 animate-pulse"
            aria-label="Run in progress"
          />
        )}
      </NavLink>
    </li>
  );
});

const COLLAPSE_KEY = 'qaai.sidebar.collapsed';

/**
 * Sidebar component.
 *
 * `mobileOpen` and `onCloseMobile` are optional — when present they enable
 * the drawer behaviour on narrow viewports (MainLayout wires them up). The
 * sidebar stays in its static column layout at `≥ md` widths regardless.
 *
 * `collapsed` and `onToggleCollapse` drive the desktop icon-only mode; both
 * are provided by MainLayout so the outer grid column width can match.
 */
function Sidebar({
  mobileOpen = false,
  onCloseMobile,
  collapsed = false,
  onToggleCollapse,
}) {
  const { profile, logout } = useAuth();
  const { running } = useRunStream();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      // Don't strand the user on the sidebar with a stale session — surface
      // the failure so they know to retry, instead of silently navigating to
      // /login while the cookie is still valid (a real risk on shared
      // machines).
      toast.error(err?.message || 'Sign-out failed. Please retry.', {
        title: 'Sign-out failed',
      });
    }
  };

  // Auto-close the drawer on route change so a NavLink click on mobile
  // doesn't leave the menu sitting on top of the new page.
  useEffect(() => {
    if (mobileOpen && onCloseMobile) onCloseMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Escape closes the drawer. Listener is only attached while open so it
  // doesn't shadow other ESC consumers on desktop.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onCloseMobile?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {/* Mobile-only scrim — visible only when drawer open. Click closes. */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        role="navigation"
        aria-label="Main navigation"
        className={`bg-ink-900 text-ink-100 flex flex-col h-screen border-r border-black/30
          fixed inset-y-0 left-0 w-64 z-50
          md:static md:w-auto md:translate-x-0 md:z-auto
          ${mobileOpen ? 'translate-x-0 sidebar-drawer-enter' : '-translate-x-full md:translate-x-0'}
        `}
      >
        {/* Brand */}
        <div className={`${collapsed ? 'px-2 justify-center' : 'px-4'} py-5 flex items-center gap-2 border-b border-white/5`}>
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-success-400 to-success-600 flex items-center justify-center shadow-pop shrink-0">
            <Sparkles className="w-4 h-4 text-white" aria-hidden="true" />
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight flex-1 min-w-0">
              <span className="font-bold text-white text-base tracking-tight">QAAI</span>
              <span className="text-2xs text-ink-400 uppercase tracking-widest font-medium">Quality Intelligence</span>
            </div>
          )}
          {mobileOpen && (
            <button
              type="button"
              onClick={onCloseMobile}
              className="md:hidden w-8 h-8 rounded-md text-ink-300 hover:bg-white/10 hover:text-white flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70"
              aria-label="Close navigation"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Nav — proper <ul> so screen readers announce "list, N items". */}
        <nav className="flex-1 overflow-y-auto py-3" aria-label="Primary">
          <ul className="list-none m-0 p-0">
            {PRIMARY.map((i) => (
              <NavItem key={i.to} {...i} showBadge={running} collapsed={collapsed} />
            ))}

            <SectionLabel id="sidebar-results" collapsed={collapsed}>Results</SectionLabel>
            {RESULTS.map((i) => <NavItem key={i.to} {...i} collapsed={collapsed} />)}

            <SectionLabel id="sidebar-knowledge" collapsed={collapsed}>Knowledge</SectionLabel>
            {KNOWLEDGE.map((i) => <NavItem key={i.to} {...i} collapsed={collapsed} />)}

            <SectionLabel id="sidebar-config" collapsed={collapsed}>Configuration</SectionLabel>
            <NavItem to="/settings" label="Settings" icon={SettingsIcon} collapsed={collapsed} />
            <NavItem to="/profile" label="Profile" icon={User} collapsed={collapsed} />
          </ul>
        </nav>

        {/* Profile footer */}
        <div className="border-t border-white/5 p-3">
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2.5'} px-2 py-2 rounded-md hover:bg-white/5 transition-colors mb-1`}>
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center text-xs font-bold text-white shadow-sm shrink-0" aria-hidden="true">
              {(profile?.firstName?.[0] || profile?.email?.[0] || '?').toUpperCase()}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white truncate leading-tight">
                  {profile?.firstName ? `${profile.firstName} ${profile.lastName || ''}` : profile?.email}
                </div>
                <div className="text-2xs text-ink-400 truncate uppercase tracking-wider font-medium">
                  {profile?.role || 'user'}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            title={collapsed ? 'Sign out' : undefined}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium text-ink-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            {!collapsed && 'Sign out'}
          </button>

          {/* Desktop-only collapse toggle. Hidden below md (drawer uses X close). */}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="hidden md:flex w-full items-center justify-center gap-1.5 h-7 mt-1 rounded-md text-2xs uppercase tracking-wider font-semibold text-ink-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-400/70 transition-colors"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={collapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed
                ? <ChevronsRight className="w-3.5 h-3.5" aria-hidden="true" />
                : (<>
                    <ChevronsLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    Collapse
                  </>)
              }
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

export { COLLAPSE_KEY };
export default memo(Sidebar);
