import React from 'react';
import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { Cpu, Bot, Sparkles, GitBranch, KanbanSquare, Webhook, Bell } from 'lucide-react';

const TABS = [
  { to: 'ai-provider', label: 'AI Provider', icon: Cpu },
  { to: 'claude', label: 'Claude API', icon: Bot },
  { to: 'gemini', label: 'Gemini API', icon: Sparkles },
  { to: 'ado', label: 'Azure DevOps', icon: GitBranch },
  { to: 'jira', label: 'Jira', icon: KanbanSquare },
  { to: 'webhook', label: 'Webhooks', icon: Webhook },
  { to: 'notifications', label: 'Notifications', icon: Bell },
];

export default function Settings() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="border-b border-ink-200 px-6 py-4 bg-white">
        <h1 className="text-lg font-bold text-ink-900">Settings</h1>
        <p className="text-xs text-ink-500">
          Configure integrations, webhooks, and notification routing.
        </p>
      </header>
      {/*
        Layout collapses to a single column below `md`. On wider viewports
        the tabs sit in a left-rail; on narrow they become a horizontal
        scrolling tab row above the content. role="tablist" + role="tab"
        give SR users the right semantics in both layouts.
      */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        <nav
          role="tablist"
          aria-label="Settings sections"
          className="
            md:w-56 md:border-r md:border-ink-200
            border-b border-ink-200
            bg-white p-2 md:p-3
            flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible
          "
        >
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              role="tab"
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap ${
                  isActive
                    ? 'bg-ink-100 text-ink-900'
                    : 'text-ink-600 hover:bg-ink-50'
                }`
              }
            >
              <t.icon className="w-4 h-4 shrink-0" />
              {t.label}
            </NavLink>
          ))}
        </nav>
        <main className="flex-1 overflow-y-auto p-4 md:p-6 pb-24 bg-ink-50">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function SettingsIndex() {
  return <Navigate to="claude" replace />;
}
