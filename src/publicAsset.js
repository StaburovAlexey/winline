const publicAssetBase = (
  import.meta.env.VITE_PUBLIC_CDN || import.meta.env.BASE_URL
).replace(/\/+$/, "");

export function publicAsset(path) {
  return `${publicAssetBase}/${String(path).replace(/^\/+/, "")}`;
}
