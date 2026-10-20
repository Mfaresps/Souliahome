/* Normalize physical scanner keys only in dedicated barcode inputs. */
(function () {
  'use strict';
  const arabicKeys = {
    'ض':'q','ص':'w','ث':'e','ق':'r','ف':'t','غ':'y','ع':'u','ه':'i','خ':'o','ح':'p',
    'ش':'a','س':'s','ي':'d','ب':'f','ل':'g','ا':'h','ت':'j','ن':'k','م':'l',
    'ئ':'z','ء':'x','ؤ':'c','ر':'v','ى':'n','ة':'m',
    'ٍ':'S','‘':'U','ِ':'A','ً':'W','ُ':'E','ٌ':'R',
    '}':'C',']':'D','[':'F','،':'K','؛':'P'
  };
  function normalize(value) {
    if (typeof value !== 'string') return value;
    // Text fallback also handles pasted codes; never rewrite arbitrary product names/SKUs.
    const candidate = value.normalize('NFKC').trim().replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g, '').replace(/^\][A-Za-z\u0600-\u06ff]\d/, '')
      .replace(/[٠-٩۰-۹]/g, char => String(char.charCodeAt(0) - (char <= '٩' ? 0x660 : 0x6f0)))
      .replace(/لآ/g, 'B').replace(/لا/g, 'b').replace(/./gu, char => arabicKeys[char] || char);
    const pack = candidate.replace(/^PK/i, '').replace(/[-\s]/g, '');
    if (/^PK/i.test(candidate) && /^\d{7}$/.test(pack)) return `PK-${pack.slice(0,6)}-${pack[6]}`;
    if (/^(?:(?:SU|PK)-[A-F\d]{24}|[A-F\d]{24}|U-?\d{4}-?\d{4}-?\d|\d{9})$/i.test(candidate)) return candidate.toUpperCase();
    return value;
  }
  function key(event) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return event.key;
    if (/^Key[A-Z]$/.test(event.code || '')) return event.shiftKey ? event.code.slice(3) : event.code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(event.code || '') && !event.shiftKey) return event.code.slice(5);
    if (/^Numpad\d$/.test(event.code || '') && /^\d$/.test(event.key)) return event.code.slice(6);
    if (event.code === 'Minus' && !event.shiftKey) return '-';
    return event.key;
  }
  document.addEventListener('keydown', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-scan-input], [data-scan-filter], [data-supplier-return-scan], #pw-order-scan, input[id^="pw-scan-"]') || input.disabled || input.readOnly) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.defaultPrevented) return;
    const latin = key(event);
    if (latin.length !== 1 || latin === event.key || !/^[A-Za-z\d-]$/.test(latin)) return;
    event.preventDefault();
    input.setRangeText(latin, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);
  // Search fields also accept scans, while ordinary Arabic names remain unchanged.
  document.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-scan-input], [data-scan-filter], [data-supplier-return-scan], #pw-order-scan, input[id^="pw-scan-"], #global-search, #iu-query, #ip-search') || input.disabled || input.readOnly || event.isComposing) return;
    const normalized = normalize(input.value);
    // A long legacy PK code can begin with seven digits; finish reading before choosing its format.
    if (/^PK-\d{6}-\d$/.test(normalized) && !/-[0-9٠-٩۰-۹]{6}-[0-9٠-٩۰-۹]$/.test(input.value)) return;
    if (normalized !== input.value) input.value = normalized;
  }, true);
  window.BarcodeInput = { normalize, key };
})();
