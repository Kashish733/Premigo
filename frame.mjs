// FaceTime hands us a fixed-shape frame with the phone's picture inside it and black bars around. Cutting the bars
// off gives the page all the pixels (small print!) and makes boxes relative to the picture, not the bars.
import sharp from 'sharp';

/** Returns an async function: { raw (RGBA), width, height } -> same shape with black bars removed. Keeps its crop steady (hysteresis). */
export function makeBarCropper() {
  let barRect = null; // { left, top, width, height } in frame pixels
  const recent = []; // detected rectangles of the last few seconds
  return async function cropBars(img) {
    const t = 160, th = Math.max(8, Math.round((t * img.height) / img.width));
    const g = await sharp(img.raw, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(t, th, { fit: 'fill' }).greyscale().raw().toBuffer();
    const colHit = new Array(t).fill(0), rowHit = new Array(th).fill(0);
    for (let y = 0; y < th; y++) for (let x = 0; x < t; x++) if (g[y * t + x] > 14) { colHit[x]++; rowHit[y]++; }
    const first = (arr, min) => arr.findIndex(v => v >= min), last = (arr, min) => arr.length - 1 - [...arr].reverse().findIndex(v => v >= min);
    const x0 = first(colHit, Math.max(2, th * 0.04)), x1 = last(colHit, Math.max(2, th * 0.04));
    const y0 = first(rowHit, Math.max(2, t * 0.04)), y1 = last(rowHit, Math.max(2, t * 0.04));
    if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) return img; // all dark: nothing to crop
    const want = {
      left: Math.floor((x0 / t) * img.width), top: Math.floor((y0 / th) * img.height),
      width: Math.ceil(((x1 - x0 + 1) / t) * img.width), height: Math.ceil(((y1 - y0 + 1) / th) * img.height),
    };
    want.width = Math.min(want.width, img.width - want.left); want.height = Math.min(want.height, img.height - want.top);
    const small = want.width * want.height < img.width * img.height * 0.88; // only crop if it removes a real chunk
    const rect = small && want.width > 64 && want.height > 64 ? want : { left: 0, top: 0, width: img.width, height: img.height };
    // A dark corner or a hand must not change the crop from one frame to the next (that shifts the picture under the
    // field boxes). Use the union of the last few seconds: it only shrinks when the picture really got smaller.
    const now = Date.now();
    recent.push({ t: now, rect, w: img.width, h: img.height });
    while (recent.length && (recent[0].t < now - 4000 || recent[0].w !== img.width || recent[0].h !== img.height)) recent.shift();
    const l = Math.min(...recent.map(e => e.rect.left)), tp = Math.min(...recent.map(e => e.rect.top));
    const r = Math.max(...recent.map(e => e.rect.left + e.rect.width)), bt = Math.max(...recent.map(e => e.rect.top + e.rect.height));
    const next = { left: l, top: tp, width: r - l, height: bt - tp };
    const moved = !barRect || ['left', 'top', 'width', 'height'].some(k => Math.abs(next[k] - barRect[k]) > 0.03 * (k === 'left' || k === 'width' ? img.width : img.height));
    if (moved) { barRect = next; console.log(`black bars: frame ${img.width}x${img.height} -> picture ${next.width}x${next.height}`); } // hysteresis: ignore small changes
    if (barRect.width === img.width && barRect.height === img.height) return img;
    const out = await sharp(img.raw, { raw: { width: img.width, height: img.height, channels: 4 } }).extract(barRect).raw().toBuffer({ resolveWithObject: true });
    return { raw: out.data, width: out.info.width, height: out.info.height };
  };
}
