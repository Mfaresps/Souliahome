import {
  CARRIERS,
  CARRIER_CODES,
  LEGACY_CARRIER_AR,
  carrierCodeFromName,
  carrierDef,
  carrierIntegration,
  carrierLabel,
  carrierSeedPrice,
  isValidCarrier,
} from '../../src/shared/carriers.constants';

describe('carriers registry', () => {
  describe('the code is the stored value', () => {
    it('every carrier has a unique, non-empty code', () => {
      const codes = CARRIERS.map((c) => c.code);
      expect(codes.every((c) => !!c && c.trim() === c)).toBe(true);
      expect(new Set(codes).size).toBe(codes.length);
    });

    it('every carrier carries both an Arabic and an English label', () => {
      for (const c of CARRIERS) {
        expect(c.ar.length).toBeGreaterThan(0);
        expect(c.en.length).toBeGreaterThan(0);
      }
    });

    // The whole point of the registry: renaming a company in Settings must not detach it
    // from historical transactions. That only holds while codes never change, so this
    // pins the shipped set — adding is fine, renaming or removing must fail here first.
    it('the shipped codes are stable', () => {
      expect(CARRIER_CODES).toEqual(expect.arrayContaining(['bosta', 'jt-express', 'mylerz']));
    });
  });

  describe('integration marks which carrier is actually wired', () => {
    it('bosta is the connected carrier', () => {
      expect(carrierIntegration('bosta')).toBe('bosta');
    });

    it('an unwired carrier reports none but stays perfectly valid', () => {
      expect(carrierIntegration('mylerz')).toBe('none');
      expect(isValidCarrier('mylerz')).toBe(true);
    });

    it('an unknown code reports none rather than throwing', () => {
      expect(carrierIntegration('does-not-exist')).toBe('none');
    });
  });

  describe('carrierLabel', () => {
    it('resolves per language', () => {
      expect(carrierLabel('bosta', 'ar')).toBe('بوسطة');
      expect(carrierLabel('bosta', 'en')).toBe('Bosta');
    });

    // A legacy row must still render something readable rather than a blank cell.
    it('falls back to the raw value for an unknown code', () => {
      expect(carrierLabel('aramex-legacy')).toBe('aramex-legacy');
    });

    it('an empty code renders as the unspecified bucket', () => {
      expect(carrierLabel('')).toBe(LEGACY_CARRIER_AR);
    });
  });

  describe('carrierCodeFromName — the bridge for legacy free-text names', () => {
    it('matches the English name, the Arabic name and the code itself', () => {
      expect(carrierCodeFromName('Bosta')).toBe('bosta');
      expect(carrierCodeFromName('بوسطة')).toBe('bosta');
      expect(carrierCodeFromName('bosta')).toBe('bosta');
    });

    it('ignores case and surrounding whitespace', () => {
      expect(carrierCodeFromName('  BOSTA  ')).toBe('bosta');
      expect(carrierCodeFromName('j&t express')).toBe('jt-express');
    });

    // Guessing would file real shipments under the wrong company, which is worse than
    // leaving them unspecified — so an unrecognised name resolves to nothing.
    it('returns empty rather than guessing at an unknown name', () => {
      expect(carrierCodeFromName('Aramex')).toBe('');
      expect(carrierCodeFromName('')).toBe('');
    });
  });

  describe('carrierSeedPrice', () => {
    it('returns the seed tariff per zone', () => {
      expect(carrierSeedPrice('bosta', 'cairo')).toBe(110);
      expect(carrierSeedPrice('bosta', 'gov')).toBe(150);
    });

    // ⚠ undefined, never 0: a missing price and a genuinely free shipment are different
    // facts, and collapsing them is the falsy bug that made a zero-priced carrier
    // silently inherit the global default price.
    it('returns undefined — not zero — for an unknown carrier', () => {
      expect(carrierSeedPrice('nope', 'cairo')).toBeUndefined();
    });
  });

  describe('carrierDef', () => {
    it('resolves a known code and rejects an unknown one', () => {
      expect(carrierDef('bosta')?.en).toBe('Bosta');
      expect(carrierDef('nope')).toBeUndefined();
      expect(isValidCarrier('nope')).toBe(false);
    });
  });
});
