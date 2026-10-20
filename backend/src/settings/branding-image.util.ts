import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export const MAX_LOGO_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_DIMENSION = 4096;

function validateSvg(buffer: Buffer): void {
  const svg = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/^\s*<\?xml[^?]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '');
  // Uploaded vectors are rasterized before serving. Disallow external resources even during rendering.
  const withoutLocalUrls = svg.replace(/url\(\s*(['"]?)#[a-z0-9_.:-]+\1\s*\)/gi, '');
  if (!/<svg\b/i.test(svg) || /<!|<\?|&#|\\|@|\bon[a-z]+\s*=|\bxml:base\s*=|<(?:[\w-]+:)?(?:script|foreignObject|iframe|object|embed)\b/i.test(svg)
    || /url\s*\(/i.test(withoutLocalUrls)
    || /\b(?:href|src)\s*=\s*(['"])(?!#)[\s\S]*?\1/i.test(svg)) {
    throw new BadRequestException('ملف SVG يجب أن يكون مستقلاً دون سكربتات أو روابط أو صور خارجية.');
  }
}

export async function prepareBrandLogo(buffer: Buffer, filename: string) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_LOGO_UPLOAD_BYTES) {
    throw new BadRequestException('اختر صورة بحجم لا يزيد عن 2 MB.');
  }
  if (!/\.(png|svg|webp|jpe?g)$/i.test(filename || '')) {
    throw new BadRequestException('الصيغ المسموحة: PNG وSVG وWebP وJPG.');
  }
  if (/\.svg$/i.test(filename) || /^[\s\uFEFF]*(?:<\?xml\b|<svg\b|<!)/i.test(buffer.toString('utf8', 0, 1024))) validateSvg(buffer);
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_LOGO_DIMENSION ** 2, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['png', 'svg', 'webp', 'jpeg'].includes(meta.format || '')) throw new Error('format');
    if (meta.format === 'svg') validateSvg(buffer);
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16 || meta.width > MAX_LOGO_DIMENSION || meta.height > MAX_LOGO_DIMENSION || (meta.pages || 1) > 1) {
      throw new BadRequestException('استخدم صورة ثابتة بأبعاد من 16 إلى 4096 بكسل لكل ضلع.');
    }
    const normalized = await image.rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 }).toBuffer({ resolveWithObject: true });
    if (normalized.data.length > 1024 * 1024) throw new BadRequestException('الصورة معقدة جداً؛ جرّب نسخة أبسط أو أصغر.');
    const icon = await sharp(normalized.data).resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    return { imageBase64: normalized.data.toString('base64'), iconBase64: icon.toString('base64'), width: normalized.info.width,
      height: normalized.info.height, sourceWidth: meta.width, sourceHeight: meta.height, bytes: normalized.data.length };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('تعذّر قراءة الصورة. تأكد من سلامة الملف ومقاسه وصيغته.');
  }
}
