import { sanitizeHelpTopicsInput, readHelpTopics, HelpTopicsError } from '../../lib/helpTopics';

describe('sanitizeHelpTopicsInput (strict write path)', () => {
  it('keeps valid topics, trims, drops blank-title rows', () => {
    const out = sanitizeHelpTopicsInput([
      { title: '  Hello  ', body: '  world  ', url: ' https://x.com ' },
      { title: '   ' },        // dropped — no title
      { title: 'No link' },    // body/url omitted when absent
    ]);
    expect(out).toEqual([
      { title: 'Hello', body: 'world', url: 'https://x.com' },
      { title: 'No link' },
    ]);
  });

  it('rejects non-array input', () => {
    expect(() => sanitizeHelpTopicsInput({} as any)).toThrow(HelpTopicsError);
    expect(() => sanitizeHelpTopicsInput(undefined as any)).toThrow(HelpTopicsError);
  });

  it('enforces the 30-topic cap', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ title: `T${i}` }));
    expect(() => sanitizeHelpTopicsInput(many)).toThrow(HelpTopicsError);
  });

  it('rejects dangerous schemes (XSS guard at the write boundary)', () => {
    expect(() => sanitizeHelpTopicsInput([{ title: 'x', url: 'javascript:alert(1)' }])).toThrow(HelpTopicsError);
    expect(() => sanitizeHelpTopicsInput([{ title: 'x', url: 'data:text/html,<script>' }])).toThrow(HelpTopicsError);
  });

  it('defaults bare domains to https://', () => {
    const out = sanitizeHelpTopicsInput([{ title: 'x', url: 'youtube.com/abc' }]);
    expect(out).toEqual([{ title: 'x', url: 'https://youtube.com/abc' }]);
  });

  it('caps title/body length', () => {
    const out = sanitizeHelpTopicsInput([{ title: 'a'.repeat(500), body: 'b'.repeat(5000) }]);
    expect(out[0].title).toHaveLength(200);
    expect(out[0].body).toHaveLength(2000);
  });
});

describe('readHelpTopics (lenient read path)', () => {
  it('returns [] for non-object / missing / non-array help', () => {
    expect(readHelpTopics(null)).toEqual([]);
    expect(readHelpTopics({})).toEqual([]);
    expect(readHelpTopics({ help: 'x' })).toEqual([]);
  });

  it('strips unsafe URLs instead of throwing (defense in depth for pre-validation data)', () => {
    const out = readHelpTopics({ help: [
      { title: 'x', url: 'javascript:alert(1)' },
      { title: 'y', url: 'https://ok.com' },
    ] });
    expect(out).toEqual([{ title: 'x' }, { title: 'y', url: 'https://ok.com' }]);
  });

  it('drops blank-title rows and caps count at 30', () => {
    const help = Array.from({ length: 40 }, (_, i) => ({ title: `T${i}` }));
    expect(readHelpTopics({ help })).toHaveLength(30);
  });
});
