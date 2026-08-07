const { normalizeInteractiveControlName } = require('../../server/services/outputLocatorFallback');

describe('website-neutral output locator fallback', () => {
  it('removes structural role and page context without knowing the provider or product', () => {
    expect(normalizeInteractiveControlName('Sign in button on Company Provider page')).toBe('Sign in');
    expect(normalizeInteractiveControlName('Continue button in the authentication dialog')).toBe('Continue');
    expect(normalizeInteractiveControlName('the button Save')).toBe('Save');
  });

  it('preserves accessible-name text that merely contains page or link words', () => {
    expect(normalizeInteractiveControlName('Open profile page')).toBe('Open profile page');
    expect(normalizeInteractiveControlName('Link to shipment details')).toBe('Link to shipment details');
  });
});
