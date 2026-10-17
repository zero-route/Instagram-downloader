import { proxyPath } from "@/lib/sign";

const DEFAULT_HOST = "best-instagram-scraper-free-1000-calls.p.rapidapi.com";
const TIMEOUT_MS = 14000;
const MAX_ATTEMPTS = 3;

type Json = Record<string, unknown>;

export type TargetKind = "post" | "reel" | "story" | "share";

export type Target = {
  url: string;
  kind: TargetKind;
  shortcode: string | null;
  username: string | null;
  id: string | null;
};

export type MediaItem = {
  type: "video" | "photo";
  src: string;
  download: string;
  direct: string | null;
  thumb: string | null;
  thumbDirect: string | null;
};

export type InstagramData = {
  id: string | null;
  kind: "Post" | "Reel" | "Story";
  mediaType: "video" | "photo" | "carousel";
  url: string;
  profileUrl: string | null;
  author: {
    username: string | null;
    fullName: string | null;
    verified: boolean;
    avatar: string | null;
    avatarDirect: string | null;
  };
  stats: {
    likes: number | null;
    comments: number | null;
    views: number | null;
  };
  timestamp: number | null;
  caption: string | null;
  items: MediaItem[];
  meta: { info: boolean; download: boolean };
};

export class ProviderError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }

  return null;
}

function count(value: unknown): number | null {
  const parsed = num(value);

  return parsed !== null && parsed >= 0 ? parsed : null;
}

export function parseTarget(raw: string): Target | null {
  let value = raw.trim();

  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^(www|m)\./, "");

  if (host !== "instagram.com" && host !== "instagr.am") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const types = ["p", "reel", "reels"];
  const codePattern = /^[A-Za-z0-9_-]+$/;

  let typeIndex = -1;

  if (parts[0] !== "share" && parts[0] !== "stories") {
    if (types.includes(parts[0] ?? "")) {
      typeIndex = 0;
    } else if (types.includes(parts[1] ?? "")) {
      typeIndex = 1;
    }
  }

  if (typeIndex >= 0) {
    const type = parts[typeIndex];
    const code = parts[typeIndex + 1];

    if (!code || !codePattern.test(code)) return null;

    const kind: TargetKind = type === "p" ? "post" : "reel";
    const path = type === "reels" ? "reel" : type;

    return {
      url: `https://www.instagram.com/${path}/${code}/`,
      kind,
      shortcode: code,
      username: typeIndex === 1 ? parts[0] : null,
      id: null,
    };
  }

  if (parts[0] === "share" && parts.length >= 2) {
    const rest = parts.slice(1);

    if (!rest.every((part) => codePattern.test(part))) return null;

    return {
      url: `https://www.instagram.com/share/${rest.join("/")}/`,
      kind: "share",
      shortcode: null,
      username: null,
      id: null,
    };
  }

  if (parts[0] === "stories" && /^\d{6,25}$/.test(parts[2] ?? "")) {
    const user = parts[1] ?? "";

    return {
      url: `https://www.instagram.com/stories/${user}/${parts[2]}/`,
      kind: "story",
      shortcode: null,
      username: /^[\w.]{1,40}$/.test(user) ? user : null,
      id: parts[2],
    };
  }

  return null;
}

type Fetched = {
  json: Json | null;
  status: number | null;
  attempts: number;
};

async function fetchEndpoint(
  path: string,
  post: string,
  isValid: (body: Json) => boolean
): Promise<Fetched> {
  const key = process.env.RAPIDAPI_KEY;

  if (!key) {
    throw new ProviderError(
      "RAPIDAPI_KEY belum dikonfigurasi di environment Vercel.",
      500
    );
  }

  const host = process.env.RAPIDAPI_HOST?.trim() || DEFAULT_HOST;
  const endpoint = `https://${host}${path}?post=${encodeURIComponent(post)}`;

  let status: number | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: {
          "X-Rapidapi-Key": key,
          "X-Rapidapi-Host": host,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      status = response.status;

      const body = obj(await response.json().catch(() => null));
      const valid = response.ok && body !== null && isValid(body);

      console.log(
        `[instagram] ${path} attempt=${attempt} http=${response.status} valid=${valid}`
      );

      if (valid && body) {
        return { json: body, status, attempts };
      }

      if ([400, 401, 403, 404, 422].includes(response.status)) {
        break;
      }
    } catch (error) {
      status = null;

      console.log(
        `[instagram] ${path} attempt=${attempt} error=${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(600 * attempt);
    }
  }

  return { json: null, status, attempts };
}

function httpUrl(value: unknown): string | null {
  const text = str(value);

  return text && /^https?:\/\//i.test(text) ? text : null;
}

type Media = {
  type: "video" | "photo";
  url: string | null;
  thumb: string | null;
};

function bestImage(node: Json): string | null {
  const width = num(node.width);
  const height = num(node.height);
  const ratio = width && height ? width / height : null;

  let best: string | null = null;
  let area = -1;

  for (const entry of arr(node.images)) {
    const image = obj(entry);
    const link = httpUrl(image?.link);
    const w = num(image?.width);
    const h = num(image?.height);

    if (!link || !w || !h) continue;

    if (ratio && Math.abs(w / h - ratio) / ratio > 0.06) continue;

    if (w * h > area) {
      area = w * h;
      best = link;
    }
  }

  return best ?? httpUrl(node.image);
}

function bestVideo(node: Json): string | null {
  const video = obj(node.video);
  const direct = httpUrl(video?.link) ?? httpUrl(node.video);

  if (direct) return direct;

  for (const entry of arr(node.videos)) {
    const link = httpUrl(obj(entry)?.link);

    if (link) return link;
  }

  return null;
}

function mediaOf(node: Json): Media | null {
  const kind = (str(node.type) ?? "").toLowerCase();
  const video = bestVideo(node);
  const image = bestImage(node);

  if (video && (kind.includes("video") || !image || kind === "")) {
    return { type: "video", url: video, thumb: image };
  }

  if (kind.includes("video") && video) {
    return { type: "video", url: video, thumb: image };
  }

  if (image) return { type: "photo", url: image, thumb: image };

  return video ? { type: "video", url: video, thumb: null } : null;
}

function isValidMedia(body: Json) {
  return mediaList(body).length > 0;
}

function mediaList(body: Json): Media[] {
  const root = obj(body.data) ?? body;
  const children = [...arr(root.carousel), ...arr(root.items)]
    .map((entry) => obj(entry))
    .filter((node): node is Json => node !== null);

  const nodes = children.length > 0 ? children : [root];

  return nodes
    .map(mediaOf)
    .filter((media): media is Media => media !== null && media.url !== null);
}

function isValidDetails(body: Json) {
  const root = obj(body.data) ?? body;

  return str(root.id) !== null || obj(root.owner) !== null;
}

function timestampOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }

  const text = str(value);

  if (!text) return null;

  const asNumber = num(text);

  if (asNumber !== null) {
    return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
  }

  const parsed = Date.parse(text);

  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60);
}

async function resolveShare(url: string): Promise<Target | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        Accept: "text/html,*/*",
      },
      signal: AbortSignal.timeout(8000),
    });

    await response.body?.cancel().catch(() => undefined);

    const resolved = parseTarget(response.url);

    return resolved && resolved.kind !== "share" ? resolved : null;
  } catch {
    return null;
  }
}

function candidatesOf(target: Target): string[] {
  const list: string[] = [];

  if (target.kind === "story" && target.id) list.push(target.id);

  list.push(target.url);

  if (target.shortcode) list.push(target.shortcode);

  return [...new Set(list)];
}

async function firstValid(
  path: string,
  candidates: string[],
  isValid: (body: Json) => boolean
) {
  let last: Fetched = { json: null, status: null, attempts: 0 };

  for (const candidate of candidates) {
    last = await fetchEndpoint(path, candidate, isValid);

    if (last.json) return last;

    if (last.status === 401 || last.status === 403 || last.status === 429) {
      break;
    }
  }

  return last;
}

export async function fetchInstagramMedia(
  input: Target
): Promise<InstagramData> {
  let target = input;

  if (target.kind === "share") {
    const resolved = await resolveShare(target.url);

    if (resolved) target = resolved;
  }

  const candidates = candidatesOf(target);

  const [mediaResult, detailResult] = await Promise.all([
    firstValid("/posts/media", candidates, isValidMedia),
    firstValid("/posts/details", candidates, isValidDetails),
  ]);

  const medias = mediaResult.json ? mediaList(mediaResult.json) : [];

  if (medias.length === 0) {
    const statuses = [mediaResult.status, detailResult.status];

    if (statuses.some((status) => status === 401 || status === 403)) {
      throw new ProviderError(
        "Akses ke penyedia API ditolak. Periksa RAPIDAPI_KEY dan pastikan sudah berlangganan API Instagram.",
        502
      );
    }

    if (statuses.some((status) => status === 429)) {
      throw new ProviderError(
        "Kuota API sedang habis atau terlalu banyak permintaan. Coba lagi beberapa saat.",
        429
      );
    }

    throw new ProviderError(
      "Media tidak ditemukan. Pastikan tautan benar, akun tidak privat, dan postingan atau story masih tersedia.",
      404
    );
  }

  const mediaRoot = obj(mediaResult.json?.data) ?? mediaResult.json ?? {};
  const detail = detailResult.json
    ? (obj(detailResult.json.data) ?? detailResult.json)
    : null;

  const owner = obj(detail?.owner) ?? obj(mediaRoot.owner);
  const username = str(owner?.username) ?? target.username;

  const shortcode =
    str(detail?.code) ?? str(mediaRoot.code) ?? target.shortcode;

  const productType = (
    str(detail?.product_type) ??
    str(mediaRoot.product_type) ??
    ""
  ).toLowerCase();

  const baseName = safeName(
    `${username || "instagram"}_${shortcode || target.id || "media"}`
  );

  const items: MediaItem[] = medias.map((media, index) => {
    const mediaUrl = media.url as string;
    const thumbUrl = media.type === "photo" ? mediaUrl : media.thumb;
    const name = medias.length > 1 ? `${baseName}_${index + 1}` : baseName;

    return {
      type: media.type,
      src: proxyPath(mediaUrl),
      download: proxyPath(mediaUrl, { name, download: true }),
      direct: media.type === "photo" ? mediaUrl : null,
      thumb: thumbUrl ? proxyPath(thumbUrl) : null,
      thumbDirect: thumbUrl,
    };
  });

  const mediaType: InstagramData["mediaType"] =
    items.length > 1 ? "carousel" : items[0].type === "video" ? "video" : "photo";

  const kind: InstagramData["kind"] =
    target.kind === "story" || productType === "story"
      ? "Story"
      : target.kind === "reel" || productType === "clips"
        ? "Reel"
        : target.kind === "post"
          ? "Post"
          : mediaType === "video"
            ? "Reel"
            : "Post";

  const avatarUrl = httpUrl(owner?.profile_picture);
  const stats = obj(detail?.stats);
  const hidden = detail?.are_likes_hidden === true;

  const caption =
    str(detail?.caption) ?? str(obj(detail?.caption)?.text) ?? str(detail?.title);

  return {
    id: shortcode ?? target.id,
    kind,
    mediaType,
    url: kind === "Story" ? target.url : (str(detail?.link) ?? target.url),
    profileUrl: username ? `https://www.instagram.com/${username}/` : null,
    author: {
      username: username ?? null,
      fullName: str(owner?.full_name),
      verified: owner?.is_verified === true,
      avatar: avatarUrl ? proxyPath(avatarUrl) : null,
      avatarDirect: avatarUrl,
    },
    stats: {
      likes: hidden ? null : count(stats?.like_count),
      comments: count(stats?.comment_count),
      views: count(stats?.view_count) ?? count(stats?.play_count),
    },
    timestamp: timestampOf(detail?.published_at),
    caption,
    items,
    meta: { info: detail !== null, download: true },
  };
}
