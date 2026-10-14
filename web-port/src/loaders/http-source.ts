/**
 * HTTP-backed `IAssetSource` (browser + Node fetch). Serves files from a URL
 * root such as "/raw/" (original game files staged by Vite) or "/assets/"
 * (converted pipeline output).
 *
 * `exists()` issues a HEAD request; servers that reject HEAD (405/501) are
 * retried once with GET so the check still works against static hosts that
 * only implement GET. `readBinary()` throws on any non-2xx response.
 */
import type { IAssetSource } from "../contracts";

/** Join the source root with a relative asset path ("a/b.bin", no leading slash). */
function joinUrl(baseUrl: string, path: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return root + path.replace(/^\/+/, "");
}

/**
 * Create an HTTP asset source rooted at `baseUrl` (default "/raw/").
 * Paths use forward slashes and never start with a slash (IAssetSource rule).
 */
export function createHttpAssetSource(baseUrl = "/raw/"): IAssetSource {
  return {
    async exists(path: string): Promise<boolean> {
      const url = joinUrl(baseUrl, path);
      let response = await fetch(url, { method: "HEAD" });
      if (response.status === 405 || response.status === 501) {
        // Some static servers disallow HEAD; retry with GET.
        response = await fetch(url, { method: "GET" });
      }
      return response.ok;
    },

    async readBinary(path: string): Promise<ArrayBuffer> {
      const url = joinUrl(baseUrl, path);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      }
      return await response.arrayBuffer();
    },
  };
}
