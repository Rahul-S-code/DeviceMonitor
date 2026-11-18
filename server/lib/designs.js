// Room design documents: hand-drawn or CAD schematics uploaded per room
// (PDF, PNG, JPEG, Visio, AutoCAD). The file type is taken from the file's
// own first bytes, never from the name or the browser's claim.
export const MAX_DESIGN_BYTES = 10 * 1024 * 1024;
export const MAX_DESIGNS_PER_ROOM = 20;

const TYPES = [
  { ext: 'pdf', mime: 'application/pdf', label: 'PDF', preview: 'open', magic: Buffer.from('%PDF-') },
  { ext: 'png', mime: 'image/png', label: 'PNG image', preview: 'image', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: 'jpg', mime: 'image/jpeg', label: 'JPEG image', preview: 'image', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  // .vsdx is a zip package; it is only offered as a download.
  { ext: 'vsdx', mime: 'application/vnd.ms-visio.drawing', label: 'Visio drawing', preview: 'download', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), names: /\.vsdx$/i },
  { ext: 'dwg', mime: 'application/acad', label: 'AutoCAD drawing', preview: 'download', magic: Buffer.from('AC10') },
];

export const DESIGN_ACCEPT = '.pdf,.png,.jpg,.jpeg,.vsdx,.dwg';

/** Work out the file type from its content. Throws if it isn't an allowed type. */
export function detectDesignType(buf, fileName = '') {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('The file is empty');
  if (buf.length > MAX_DESIGN_BYTES) throw new Error('Files can be up to 10 MB');
  const t = TYPES.find((x) => buf.subarray(0, x.magic.length).equals(x.magic) && (!x.names || x.names.test(fileName)));
  if (!t) throw new Error('Upload a PDF, PNG, JPEG, Visio (.vsdx) or AutoCAD (.dwg) file');
  return { ext: t.ext, mime: t.mime, label: t.label, preview: t.preview };
}

export const cleanFileName = (name) => String(name || 'design').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'design';
