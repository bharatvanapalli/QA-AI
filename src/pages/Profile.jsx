import React, { useMemo } from 'react';
import {
  BadgeCheck,
  Building2,
  CalendarDays,
  Clock3,
  Mail,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuth } from '../store/auth';
import PageHeader from '../components/PageHeader';

export default function Profile() {
  const { profile } = useAuth();

  const displayName = useMemo(
    () => [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || 'QAAI User',
    [profile?.firstName, profile?.lastName]
  );

  const initials = useMemo(() => {
    const parts = displayName.split(/\s+/).filter(Boolean);
    return (parts[0]?.[0] || 'Q') + (parts[1]?.[0] || '');
  }, [displayName]);

  if (!profile) return null;

  const memberSince = fmtDate(profile.createdAt);
  const lastLogin = fmtDateTime(profile.lastLoginAt);
  const organisation = profile.organisation || 'Not set';
  const role = formatRole(profile.role);

  const rows = [
    { icon: Mail, label: 'Email', value: profile.email || '-' },
    { icon: UserRound, label: 'Name', value: displayName },
    { icon: Building2, label: 'Organisation', value: organisation },
    { icon: BadgeCheck, label: 'Role', value: role },
    ...(profile.lastLoginAt ? [{ icon: Clock3, label: 'Last login', value: lastLogin }] : []),
    { icon: CalendarDays, label: 'Member since', value: memberSince },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Profile" subtitle="Your QAAI account and workspace identity" />

      <main
        className="flex-1 overflow-y-auto relative"
        style={{ scrollbarGutter: 'stable' }}
      >
        <div
          className="sticky top-0 overflow-hidden pointer-events-none"
          style={{ height: '100dvh', marginBottom: '-100dvh', zIndex: 0 }}
          aria-hidden="true"
        >
          <ProfileAurora />
        </div>

        <div className="relative z-10 max-w-6xl mx-auto px-page py-8 space-y-5">
          <section className="glass overflow-hidden transition-all duration-300 ease-out-soft hover:-translate-y-1 hover:ring-1 hover:ring-white/80 hover:shadow-card-hover">
            <div className="relative p-6 md:p-8 lg:p-9">
              <div
                className="absolute inset-x-0 top-0 h-32 bg-gradient-to-r from-success-200/40 via-white/30 to-info-200/35"
                aria-hidden="true"
              />

              <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                <div className="flex items-center gap-5 md:gap-6 min-w-0">
                  <div className="relative shrink-0">
                    <div
                      className="h-20 w-20 md:h-24 md:w-24 rounded-[30px] text-white shadow-pop inline-flex items-center justify-center text-3xl md:text-4xl font-bold ring-1 ring-white/70 transition-transform duration-300 ease-out-soft hover:scale-[1.03]"
                      style={{ background: 'linear-gradient(135deg, #0b1220 0%, #1f242d 100%)' }}
                    >
                      {initials.toUpperCase()}
                    </div>
                    <span className="absolute right-2 bottom-2 h-8 w-8 rounded-full bg-success-500 border-4 border-white inline-flex items-center justify-center shadow-card">
                      <BadgeCheck className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                    </span>
                  </div>

                  <div className="min-w-0">
                    <div className="text-2xs uppercase tracking-[0.2em] font-bold text-ink-500 mb-1.5">
                      Account identity
                    </div>
                    <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-ink-900 leading-[1.02]">
                      {displayName}
                    </h1>
                    <p className="mt-2 text-sm md:text-base text-ink-600 break-all">{profile.email || '-'}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <ProfileChip icon={Building2} label={organisation} />
                  <ProfileChip icon={ShieldCheck} label={role} tone="success" />
                </div>
              </div>
            </div>
          </section>

          <div className="grid lg:grid-cols-[1.45fr_0.55fr] gap-5 items-start">
            <section className="glass p-5 md:p-6 transition-all duration-300 ease-out-soft hover:-translate-y-1 hover:ring-1 hover:ring-white/80 hover:shadow-card-hover">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <div className="text-2xs uppercase tracking-[0.2em] font-bold text-ink-500 mb-1">
                    Profile record
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight text-ink-900">Account details</h2>
                </div>
                <span className="rounded-pill border border-success-200 bg-success-50 px-3 py-1 text-2xs font-bold uppercase tracking-[0.14em] text-success-700">
                  Active
                </span>
              </div>

              <div className="divide-y divide-white/60 overflow-hidden rounded-2xl border border-white/70 bg-white/35">
                {rows.map((row) => (
                  <ProfileRow key={row.label} {...row} />
                ))}
              </div>
            </section>

            <aside>
              <section className="group glass-soft p-5 transition-all duration-300 ease-out-soft hover:-translate-y-1 hover:bg-white/82 hover:ring-1 hover:ring-success-200/80 hover:shadow-card-hover">
                <div className="flex items-start gap-3">
                  <ProfileIconFrame icon={ShieldCheck} size="md" />
                  <div>
                    <div className="text-sm font-semibold text-ink-900">Workspace access</div>
                    <p className="mt-1 text-xs leading-relaxed text-ink-600">
                      Your role controls QAAI navigation, project access, and execution permissions.
                    </p>
                  </div>
                </div>
                <div className="mt-4 rounded-2xl border border-white/70 bg-white/55 px-4 py-3">
                  <div className="text-2xs uppercase tracking-[0.16em] font-bold text-ink-500">Current role</div>
                  <div className="mt-1 text-2xl font-bold text-ink-900">{role}</div>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}

function ProfileAurora() {
  return (
    <div className="aurora-canvas grain-overlay" aria-hidden="true">
      <div
        className="aurora-orb aurora-orb-success aurora-drift-1"
        style={{ width: '46vw', height: '46vw', top: '-10vw', left: '-8vw', opacity: 0.38 }}
      />
      <div
        className="aurora-orb aurora-orb-info aurora-drift-2"
        style={{ width: '42vw', height: '42vw', top: '-6vw', right: '-8vw', opacity: 0.42 }}
      />
      <div
        className="aurora-orb aurora-orb-accent aurora-drift-3"
        style={{ width: '38vw', height: '38vw', bottom: '-12vw', left: '28vw', opacity: 0.3 }}
      />
    </div>
  );
}

function ProfileChip({ icon: Icon, label, tone = 'ink' }) {
  const tones = {
    ink: 'border-ink-200/80 bg-white/92 text-ink-800 hover:border-ink-400 hover:bg-white hover:text-ink-900 hover:shadow-card-hover',
    success: 'border-success-200 bg-success-50 text-success-800 hover:border-success-400 hover:bg-white hover:text-success-800 hover:shadow-[0_12px_30px_rgba(16,185,129,0.22)]',
  };
  return (
    <span className={`group/chip inline-flex h-10 items-center gap-2 rounded-pill border px-4 text-xs font-semibold shadow-sm backdrop-blur transition-all duration-300 ease-out-soft hover:-translate-y-0.5 hover:ring-2 hover:ring-white/80 ${tones[tone] || tones.ink}`}>
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white border border-ink-100 text-ink-800 transition-all duration-300 group-hover/chip:border-success-200 group-hover/chip:bg-success-50 group-hover/chip:text-success-700">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      {label}
    </span>
  );
}

function ProfileIconFrame({ icon: Icon, size = 'sm' }) {
  const dims = size === 'md' ? 'h-10 w-10 rounded-xl' : 'h-11 w-11 rounded-2xl';
  const iconSize = size === 'md' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <div
      className={`${dims} bg-white border border-ink-200 text-ink-800 inline-flex items-center justify-center shrink-0 shadow-card transition-all duration-300 ease-out-soft group-hover:scale-[1.04] group-hover:border-success-300 group-hover:bg-success-50 group-hover:shadow-ring-emerald`}
    >
      <Icon className={`${iconSize} text-current`} strokeWidth={2.2} aria-hidden="true" />
    </div>
  );
}

function ProfileRow({ icon: Icon, label, value }) {
  return (
    <div className="group relative flex items-center gap-4 px-5 py-4 transition-all duration-300 ease-out-soft hover:bg-white/82 hover:shadow-[inset_4px_0_0_rgba(16,185,129,0.65),0_12px_30px_-18px_rgba(15,23,42,0.35)]">
      <ProfileIconFrame icon={Icon} />
      <div className="min-w-0 flex-1">
        <div className="text-2xs uppercase tracking-[0.16em] font-bold text-ink-500 transition-colors group-hover:text-success-700">{label}</div>
        <div className="mt-0.5 text-sm font-semibold text-ink-900 break-words">{value}</div>
      </div>
    </div>
  );
}

function formatRole(role) {
  if (!role) return 'User';
  return String(role)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

// Guard against a missing or unparseable date so we never render "Invalid Date".
function fmtDate(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString();
}

function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}
