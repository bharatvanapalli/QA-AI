'use strict';

function compact(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function snapshotShowsCredentialEntry(snapshotText = '') {
  const text = compact(snapshotText);
  if (!text) return false;
  const credentialControl = /\b(?:textbox|input|field)\b[^\n]{0,100}\b(?:password|passcode|email|e-mail|username|user id|account|phone)\b/i.test(text)
    || /\b(?:type|autocomplete)\s*=\s*["']?(?:password|username|email|one-time-code)\b/i.test(text);
  const credentialPrompt = /\b(?:enter|provide|type)\b[^.\n]{0,80}\b(?:password|passcode|email|e-mail|username|user id|account)\b/i.test(text);
  const authAction = /\b(?:sign\s*in|log\s*in|authenticate|continue|next|verify)\b/i.test(text);
  return credentialControl || (credentialPrompt && authAction);
}

function snapshotLooksLikeAuthBlockingState(snapshotText = '') {
  const text = compact(snapshotText);
  if (!text) return false;
  const explicitError = /\b(?:invalid|incorrect|wrong|expired|missing|required|could not|couldn['’]?t|failed|try again)\b[^.\n]{0,100}\b(?:password|passcode|email|e-mail|username|credentials?|authentication|sign\s*in|log\s*in)\b/i.test(text)
    || /\b(?:password|passcode|email|e-mail|username|credentials?)\b[^.\n]{0,100}\b(?:is required|must be entered|cannot be blank|was not accepted)\b/i.test(text);
  return explicitError || snapshotShowsCredentialEntry(text);
}

function expectedIsCredentialSubmitOutcome(...values) {
  const text = compact(values.filter(Boolean).join(' '));
  const credentialIntent = /\b(?:sign\s*in|log\s*in|authenticate|authentication|credential|password|passcode)\b/i.test(text);
  const submitOrOutcome = /\b(?:submit|submitted|process|processing|authenticate|authenticated|signed\s*in|logged\s*in|continue|redirect|destination|application|portal|workspace|dashboard|home)\b/i.test(text);
  return credentialIntent && submitOrOutcome;
}

function expectedIsNonAuthDestination(...values) {
  const text = compact(values.filter(Boolean).join(' '));
  const destination = /\b(?:dashboard|home|workspace|application|app|portal|landing|overview|main page|destination page|results?|details?|list|authenticated area)\b/i.test(text);
  const credentialEntry = /\b(?:sign\s*in|log\s*in|enter\s+(?:a\s+|your\s+)?(?:password|passcode|email|username)|authentication\s+(?:page|screen|form)|credential\s+(?:page|screen|form))\b/i.test(text);
  return destination && !credentialEntry;
}

function expectedIsAuthProviderTransition(...values) {
  const text = compact(values.filter(Boolean).join(' '));
  const providerIntent = /\b(?:identity\s*provider|authentication\s*provider|federated\s+(?:identity|sign\s*in)|external\s+sign\s*in|single\s+sign[- ]?on|sso|oauth|oidc|idp|work\s+or\s+school)\b/i.test(text);
  const transition = /\b(?:loading|loaded|begins?|redirect(?:s|ed|ing)?|opens?|opened|reach(?:es|ed)?|lands?|navigat(?:e|es|ed|ing)|transitions?|continues?)\b/i.test(text);
  return providerIntent && transition;
}

function snapshotShowsPostAuthApplication(snapshotText = '') {
  const text = compact(snapshotText);
  if (!text || snapshotLooksLikeAuthBlockingState(text)) return false;
  const applicationStructure = /\b(?:main|navigation|region|table|grid)\b/i.test(text)
    && /\b(?:heading|link|button|menu|tab)\b/i.test(text);
  const authenticatedSignal = /\b(?:sign\s*out|log\s*out|my\s+account|user\s+menu|profile\s+menu|account\s+menu|authenticated)\b/i.test(text);
  const destinationSignal = /\b(?:dashboard|home|workspace|overview|welcome)\b/i.test(text);
  return applicationStructure && (authenticatedSignal || destinationSignal);
}

function parseBrowserUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch (_) {
    return null;
  }
}

function urlHasCredentialEntryRole(value) {
  const url = value instanceof URL ? value : parseBrowserUrl(value);
  if (!url) return false;
  const route = `${url.pathname} ${url.search}`.toLowerCase();
  return /(?:^|[\/_?&=.-])(?:login|log-in|signin|sign-in|authenticate|authentication|authorize|authorization|oauth|oidc|sso)(?:$|[\/_?&=.-])/i.test(route);
}

function authSubmitUrlLooksPostAuth(url = '', beforeUrl = '') {
  const after = parseBrowserUrl(url);
  const before = parseBrowserUrl(beforeUrl);
  if (!after || urlHasCredentialEntryRole(after)) return false;
  if (!before) return false;
  if (after.origin !== before.origin) return true;
  const beforeIdentity = `${before.pathname}${before.search}${before.hash}`;
  const afterIdentity = `${after.pathname}${after.search}${after.hash}`;
  return beforeIdentity !== afterIdentity && urlHasCredentialEntryRole(before);
}

module.exports = {
  compact,
  snapshotShowsCredentialEntry,
  snapshotLooksLikeAuthBlockingState,
  expectedIsCredentialSubmitOutcome,
  expectedIsNonAuthDestination,
  expectedIsAuthProviderTransition,
  snapshotShowsPostAuthApplication,
  urlHasCredentialEntryRole,
  authSubmitUrlLooksPostAuth,
};
