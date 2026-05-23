import React from 'react';

/**
 * EmptyState — supports two presentations:
 *
 *   1. `illustration={'overview'|'tests'|'reports'|'project'}` — renders a
 *      small bespoke SVG hero appropriate for that surface. Looks less
 *      templated than the generic icon-in-circle treatment.
 *
 *   2. `icon={SomeLucideIcon}` (default) — falls back to the simple
 *      icon-in-circle for surfaces that don't have a dedicated
 *      illustration yet. Keeps every existing call site working.
 *
 * Only one of `illustration` / `icon` should be set; if both are given the
 * illustration wins.
 */
export default function EmptyState({ icon: Icon, illustration, title, message, action }) {
  const Hero = illustration ? ILLUSTRATIONS[illustration] : null;
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-page">
      {Hero ? (
        <Hero className="w-32 h-32 mb-4" aria-hidden="true" />
      ) : Icon ? (
        <div className="w-14 h-14 rounded-2xl bg-ink-100 flex items-center justify-center mb-4">
          <Icon className="w-6 h-6 text-ink-400" />
        </div>
      ) : null}
      <h2 className="text-md font-semibold text-ink-900 mb-1.5">{title}</h2>
      <p className="text-sm text-ink-500 max-w-md leading-relaxed">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ── Small bespoke SVG illustrations ─────────────────────────────
// Hand-rolled, deliberately simple. They use the ink/success/info palette so
// they fit in light theme without standing out as third-party clipart.

function OverviewIllustration({ className }) {
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none">
      <rect x="20" y="40" width="120" height="100" rx="10" fill="#eef0f4" stroke="#dfe3eb" strokeWidth="2" />
      <rect x="32" y="56" width="40" height="6" rx="3" fill="#c4cad6" />
      <rect x="32" y="72" width="60" height="32" rx="4" fill="#dbeafe" />
      <path d="M40 96 L52 84 L64 92 L80 76" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="100" y="72" width="28" height="32" rx="4" fill="#d1fadf" />
      <rect x="32" y="112" width="96" height="6" rx="3" fill="#dfe3eb" />
      <rect x="32" y="122" width="64" height="6" rx="3" fill="#eef0f4" />
      <circle cx="118" cy="48" r="10" fill="#10b981" opacity="0.15" />
      <circle cx="118" cy="48" r="5" fill="#10b981" />
    </svg>
  );
}

function TestsIllustration({ className }) {
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none">
      <rect x="28" y="32" width="104" height="100" rx="8" fill="#eef0f4" stroke="#dfe3eb" strokeWidth="2" />
      <rect x="40" y="48" width="60" height="6" rx="3" fill="#c4cad6" />
      <circle cx="116" cy="51" r="4" fill="#10b981" />
      <rect x="40" y="68" width="80" height="6" rx="3" fill="#dfe3eb" />
      <circle cx="116" cy="71" r="4" fill="#10b981" />
      <rect x="40" y="88" width="50" height="6" rx="3" fill="#dfe3eb" />
      <circle cx="116" cy="91" r="4" fill="#ef4444" />
      <rect x="40" y="108" width="70" height="6" rx="3" fill="#dfe3eb" />
      <circle cx="116" cy="111" r="4" fill="#f59e0b" />
    </svg>
  );
}

function ReportsIllustration({ className }) {
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none">
      <rect x="20" y="40" width="120" height="90" rx="8" fill="#eef0f4" stroke="#dfe3eb" strokeWidth="2" />
      <rect x="32" y="105" width="14" height="18" fill="#10b981" />
      <rect x="52" y="92" width="14" height="31" fill="#3b82f6" />
      <rect x="72" y="78" width="14" height="45" fill="#10b981" />
      <rect x="92" y="98" width="14" height="25" fill="#f59e0b" />
      <rect x="112" y="86" width="14" height="37" fill="#ef4444" />
      <line x1="28" y1="123" x2="132" y2="123" stroke="#c4cad6" strokeWidth="1.5" />
      <rect x="32" y="52" width="40" height="5" rx="2.5" fill="#c4cad6" />
    </svg>
  );
}

function ProjectIllustration({ className }) {
  return (
    <svg className={className} viewBox="0 0 160 160" fill="none">
      <path d="M30 56 L30 124 C30 128 33 131 37 131 L123 131 C127 131 130 128 130 124 L130 56 L80 56 L70 48 L37 48 C33 48 30 51 30 56 Z" fill="#eef0f4" stroke="#dfe3eb" strokeWidth="2" />
      <rect x="50" y="72" width="60" height="6" rx="3" fill="#c4cad6" />
      <rect x="50" y="88" width="40" height="6" rx="3" fill="#dfe3eb" />
      <rect x="50" y="104" width="50" height="6" rx="3" fill="#dfe3eb" />
      <circle cx="118" cy="48" r="12" fill="#8b5cf6" opacity="0.18" />
      <path d="M118 42 L118 54 M112 48 L124 48" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const ILLUSTRATIONS = {
  overview: OverviewIllustration,
  tests:    TestsIllustration,
  reports:  ReportsIllustration,
  project:  ProjectIllustration,
};
