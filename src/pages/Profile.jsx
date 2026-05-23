import React from 'react';
import { useAuth } from '../store/auth';
import Button from '../components/ui/Button';

export default function Profile() {
  const { profile, logout } = useAuth();
  if (!profile) return null;
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-lg font-bold text-ink-900 mb-1">Profile</h1>
      <p className="text-xs text-ink-500 mb-6">Your QAAI account.</p>
      <div className="rounded-lg border border-ink-200 bg-white p-5 space-y-3">
        <Row label="Email" value={profile.email} />
        <Row label="Name" value={[profile.firstName, profile.lastName].filter(Boolean).join(' ') || '—'} />
        <Row label="Organisation" value={profile.organisation || '—'} />
        <Row label="Role" value={profile.role} />
        {profile.lastLoginAt && (
          <Row label="Last login" value={new Date(profile.lastLoginAt).toLocaleString()} />
        )}
        <Row label="Member since" value={new Date(profile.createdAt).toLocaleDateString()} />
      </div>
      <div className="mt-4">
        <Button variant="danger" size="sm" onClick={logout}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-500">{label}</span>
      <span className="text-ink-900 font-medium">{value}</span>
    </div>
  );
}
