import sharp from 'sharp';
import { MAX_LOGO_UPLOAD_BYTES, prepareBrandLogo } from '../../src/settings/branding-image.util';

describe('Logo image processing', () => {
  it.each(['png', 'jpeg', 'webp', 'svg'])('accepts %s and produces safe, proportionate artwork and a square icon', async format => {
    const input = format === 'svg' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200" fill="#137b51"/></svg>')
      : await sharp({ create: { width: 800, height: 200, channels: 4, background: '#137b51' } }).toFormat(format as any).toBuffer();
    const output = await prepareBrandLogo(input, 'named-logo.' + (format === 'jpeg' ? 'jpg' : format));
    const logo = await sharp(Buffer.from(output.imageBase64, 'base64')).metadata();
    const icon = await sharp(Buffer.from(output.iconBase64, 'base64')).metadata();
    expect([logo.format, logo.width, logo.height]).toEqual(['webp', 800, 200]);
    expect([icon.format, icon.width, icon.height]).toEqual(['png', 64, 64]);
    expect(logo.exif).toBeUndefined();
  });

  it('scales large artwork without distortion and retains transparency', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="512"><circle cx="1024" cy="256" r="200" fill="red"/></svg>');
    const result = await prepareBrandLogo(svg, 'wide.svg');
    expect([result.width, result.height]).toEqual([1024, 256]);
    const icon = await sharp(Buffer.from(result.iconBase64, 'base64')).raw().toBuffer({ resolveWithObject: true });
    expect(icon.info.channels).toBe(4);
    expect(icon.data[3]).toBe(0);
  });

  it.each([
    '<script>alert(1)</script>', '<foreignObject/>', '<image href="file:///etc/passwd"/>',
    '<use href="https://example.test/logo.svg#x"/>', '<style>.x{fill:url(file:///private)}</style>',
    '<style>@import "https://example.test/x.css";</style>', '<rect onclick="alert(1)"/>',
    '<style>.x{fill:&#117;rl(file:///private)}</style>',
  ])('rejects active or external SVG content: %s', async content => {
    const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${content}</svg>`);
    await expect(prepareBrandLogo(input, 'logo.svg')).rejects.toThrow();
  });

  it('rejects entity declarations, fake files, unsupported formats, oversized files and dimensions', async () => {
    await expect(prepareBrandLogo(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg width="100" height="100">&x;</svg>'), 'logo.svg')).rejects.toThrow();
    await expect(prepareBrandLogo(Buffer.from('not an image'), 'logo.png')).rejects.toThrow();
    await expect(prepareBrandLogo(Buffer.alloc(MAX_LOGO_UPLOAD_BYTES + 1), 'logo.png')).rejects.toThrow();
    await expect(prepareBrandLogo(Buffer.from('gif'), 'logo.gif')).rejects.toThrow();
    await expect(prepareBrandLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4097" height="20"/>'), 'logo.svg')).rejects.toThrow();
    await expect(prepareBrandLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), 'logo.svg')).rejects.toThrow();
  });
});
