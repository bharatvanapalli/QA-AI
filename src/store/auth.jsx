import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { ApiError } from '../lib/apiClient';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState('checking'); // checking | authed | guest

  const fetchMe = useCallback(async () => {
    try {
      const res = await api.me();
      setProfile(res.profile);
      setStatus('authed');
      // Ensure we have a CSRF token cookie for mutating requests
      try {
        await api.csrfToken();
      } catch (_) {}
    } catch (err) {
      setProfile(null);
      setStatus('guest');
    }
  }, []);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  const login = useCallback(
    async (email, password) => {
      const res = await api.login(email, password);
      setProfile(res.profile);
      setStatus('authed');
      try {
        await api.csrfToken();
      } catch (_) {}
      return res.profile;
    },
    []
  );

  const signup = useCallback(async (data) => {
    const res = await api.signup(data);
    setProfile(res.profile);
    setStatus('authed');
    try {
      await api.csrfToken();
    } catch (_) {}
    return res.profile;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (_) {}
    setProfile(null);
    setStatus('guest');
  }, []);

  return (
    <AuthCtx.Provider value={{ profile, status, login, signup, logout, refresh: fetchMe }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}

export { ApiError };
