import { logoPixelSize } from "./pipeline";

// Safe symbol from the official Safe Media Kit, drawn as line art for the
// rim-lit flare: two brackets and the center square, stroked instead of filled.
const LOGO_SVG =
  '<svg width="661.62" height="661.47" viewBox="0 0 661.62 661.47" fill="none" ' +
  'xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M531.98,330.7h-49.42c-14.76,0-26.72,11.96-26.72,26.72v71.73' +
  'c0,14.76-11.96,26.72-26.72,26.72H232.51c-14.76,0-26.72,11.96-26.72,26.72' +
  'v49.42c0,14.76,11.96,26.72,26.72,26.72h207.99c14.76,0,26.55-11.96,26.55-26.72' +
  'v-39.65c0-14.76,11.96-25.23,26.72-25.23h38.2c14.76,0,26.72-11.96,26.72-26.72' +
  'v-83.3c0-14.76-11.96-26.41-26.72-26.41Z" stroke="#EDEDED" stroke-width="2" ' +
  'vector-effect="non-scaling-stroke"/>' +
  '<path d="M205.78,232.52c0-14.76,11.96-26.72,26.72-26.72h196.49' +
  'c14.76,0,26.72-11.96,26.72-26.72v-49.42c0-14.76-11.96-26.72-26.72-26.72' +
  'H221.11c-14.76,0-26.72,11.96-26.72,26.72v38.08c0,14.76-11.96,26.72-26.72,26.72' +
  'h-38.03c-14.76,0-26.72,11.96-26.72,26.72v83.39c0,14.76,12.01,26.12,26.77,26.12' +
  'h49.42c14.76,0,26.72-11.96,26.72-26.72l-.05-71.44Z" stroke="#EDEDED" ' +
  'stroke-width="2" vector-effect="non-scaling-stroke"/>' +
  '<path d="M307.55,278.75h47.47c15.47,0,28.02,12.56,28.02,28.02v47.47' +
  'c0,15.47-12.56,28.02-28.02,28.02h-47.47c-15.47,0-28.02-12.56-28.02-28.02' +
  'v-47.47c0-15.47,12.56-28.02,28.02-28.02Z" stroke="#EDEDED" stroke-width="2" ' +
  'vector-effect="non-scaling-stroke"/></svg>';

export async function rasterizeLogo(
  size: number,
  signal?: AbortSignal
): Promise<HTMLCanvasElement> {
  if (signal?.aborted)
    throw new DOMException("Logo rasterization aborted.", "AbortError");
  const [width, height] = logoPixelSize(size);
  const pad = 3;
  const canvas = document.createElement("canvas");
  canvas.width = width + pad * 2;
  canvas.height = height + pad * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the logo raster canvas.");
  const image = new Image();
  let abort: (() => void) | undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error("Could not decode the Safe logo SVG."));
    abort = () => {
      image.onload = null;
      image.onerror = null;
      image.src = "";
      reject(new DOMException("Logo rasterization aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  if (signal?.aborted) abort?.();
  else
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      LOGO_SVG
    )}`;
  try {
    await loaded;
  } finally {
    image.onload = null;
    image.onerror = null;
    if (abort) signal?.removeEventListener("abort", abort);
  }
  if (signal?.aborted)
    throw new DOMException("Logo rasterization aborted.", "AbortError");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, pad, pad, width, height);
  return canvas;
}
