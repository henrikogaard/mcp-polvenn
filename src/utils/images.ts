import { VINMONOPOLET_IMAGE_BASE } from "../constants.js";

const STANDARD_SIZES = new Set([300, 515, 1200]);

/**
 * Builds a Vinmonopolet product image URL (no auth required; documented at
 * https://api.vinmonopolet.no/blog/product-images). Images are best-effort:
 * products without a photo return a placeholder silhouette, and use of the
 * CDN is covered by the API terms of service.
 */
export function buildProductImageUrl(articleNumber: string, size = 300): string {
  const dimension = STANDARD_SIZES.has(size) ? size : 300;
  // Article numbers in image URLs have no leading zeros.
  const normalized = articleNumber.replace(/^0+/, "") || articleNumber;
  return `${VINMONOPOLET_IMAGE_BASE}/${dimension}x${dimension}-0/${normalized}-1.jpg`;
}
