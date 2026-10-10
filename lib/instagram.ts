import { proxyPath } from "@/lib/sign";

const DEFAULT_HOST = "instagram-looter2.p.rapidapi.com";
const TIMEOUT_MS = 14000;
const MAX_ATTEMPTS = 3;

type Json = Record<string, unknown>;

export type TargetKind = "post" | "reel" | "share";

export type Target = {
  url: string;
  kind: TargetKind;
  shortcode: string | null;
  username: string | null;
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
  kind: "Post" | "Reel";
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

  if (parts[0] !== "share") {
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
  url: string,
  isValid: (body: Json) => boolean
): Promise<Fetched> {
  const key = process.env.RAPIDAPI_KEY;

  if (!key) {
    throw new ProviderError(
      "RAPIDAPI_KEY belum dikonfigurasi di environment Vercel.",
      500
    );
  }

  const host = process.env.RAPIDAPI_HOST || DEFAULT_HOST;
  const endpoint = `https://${host}${path}?${new URLSearchParams({ url }).toString()}`;

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

function infoRoot(body: Json): Json {
  if (
    body.owner ||
    body.shortcode ||
    body.__typename ||
    body.edge_sidecar_to_children
  ) {
    return body;
  }

  return obj(body.data) ?? body;
}

function isValidInfo(body: Json) {
  if (body.status === false) return false;

  const root = infoRoot(body);

  return obj(root.owner) !== null || str(root.shortcode) !== null;
}

function downloadRoot(body: Json): Json {
  return obj(body.data) ?? body;
}

function isValidDownload(body: Json) {
  if (body.status === false) return false;

  return arr(downloadRoot(body).medias).some(
    (item) => str(obj(item)?.link) !== null
  );
}

type Media = {
  type: "video" | "photo";
  url: string | null;
  thumb: string | null;
};

function bestResource(node: Json): string | null {
  let best: string | null = null;
  let area = -1;

  for (const entry of arr(node.display_resources)) {
    const resource = obj(entry);
    const src = str(resource?.src);

    if (!src) continue;

    const size =
      (num(resource?.config_width) ?? 0) * (num(resource?.config_height) ?? 0);

    if (size > area) {
      area = size;
      best = src;
    }
  }

  return best ?? str(node.display_url) ?? str(node.thumbnail_src);
}

function captionOf(root: Json): string | null {
  const edges = arr(obj(root.edge_media_to_caption)?.edges);
  const text = str(obj(obj(edges[0])?.node)?.text);

  if (text) return text;

  if (typeof root.caption === "string") return str(root.caption);

  return str(obj(root.caption)?.text);
}

type Info = {
  shortcode: string | null;
  username: string | null;
  fullName: string | null;
  avatar: string | null;
  verified: boolean;
  likes: number | null;
  comments: number | null;
  views: number | null;
  caption: string | null;
  timestamp: number | null;
  medias: Media[];
};

function parseInfo(body: Json): Info {
  const root = infoRoot(body);
  const owner = obj(root.owner);
  const hidden = root.like_and_view_counts_disabled === true;

  const children = arr(obj(root.edge_sidecar_to_children)?.edges)
    .map((edge) => obj(obj(edge)?.node))
    .filter((node): node is Json => node !== null);

  const nodes = children.length > 0 ? children : [root];

  const medias = nodes
    .map((node): Media => {
      const video = node.is_video === true || str(node.video_url) !== null;
      const image = bestResource(node);

      return {
        type: video ? "video" : "photo",
        url: video ? str(node.video_url) : image,
        thumb: image,
      };
    })
    .filter((media) => media.url !== null);

  return {
    shortcode: str(root.shortcode),
    username: str(owner?.username),
    fullName: str(owner?.full_name),
    avatar: str(owner?.profile_pic_url_hd) ?? str(owner?.profile_pic_url),
    verified: owner?.is_verified === true,
    likes: hidden
      ? null
      : count(obj(root.edge_media_preview_like)?.count) ??
        count(obj(root.edge_liked_by)?.count) ??
        count(root.like_count),
    comments:
      count(obj(root.edge_media_to_parent_comment)?.count) ??
      count(obj(root.edge_media_preview_comment)?.count) ??
      count(obj(root.edge_media_to_comment)?.count) ??
      count(root.comment_count),
    views:
      count(root.video_view_count) ??
      count(root.video_play_count) ??
      count(root.view_count) ??
      count(root.play_count),
    caption: captionOf(root),
    timestamp: num(root.taken_at_timestamp) ?? num(root.taken_at),
    medias,
  };
}

type Download = {
  username: string | null;
  fullName: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  caption: string | null;
  timestamp: number | null;
  medias: Media[];
};

function parseDownload(body: Json): Download {
  const root = downloadRoot(body);

  const medias = arr(root.medias)
    .map((entry): Media | null => {
      const media = obj(entry);
      const link = str(media?.link);

      if (!media || !link) return null;

      const kind = (str(media.type) ?? "").toLowerCase();
      const video =
        kind.includes("video") || /\.mp4$/i.test(link.split("?")[0]);

      return {
        type: video ? "video" : "photo",
        url: link,
        thumb:
          str(media.thumbnail) ??
          str(media.thumbnail_url) ??
          str(media.thumb) ??
          str(media.cover) ??
          str(media.preview) ??
          str(media.image),
      };
    })
    .filter((media): media is Media => media !== null);

  return {
    username: str(root.username),
    fullName: str(root.full_name),
    likes: count(root.like_count),
    comments: count(root.comment_count),
    views: count(root.view_count) ?? count(root.play_count),
    caption: captionOf(root),
    timestamp: num(root.taken_at_timestamp),
    medias,
  };
}

function longerText(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;

  return b.length > a.length ? b : a;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60);
}

export async function fetchInstagramMedia(
  target: Target
): Promise<InstagramData> {
  const [infoResult, downloadResult] = await Promise.all([
    fetchEndpoint("/post", target.url, isValidInfo),
    fetchEndpoint("/post-dl", target.url, isValidDownload),
  ]);

  const info = infoResult.json ? parseInfo(infoResult.json) : null;
  const download = downloadResult.json
    ? parseDownload(downloadResult.json)
    : null;

  const base: Media[] =
    download && download.medias.length > 0
      ? download.medias
      : (info?.medias ?? []);

  if (base.length === 0) {
    const statuses = [infoResult.status, downloadResult.status];

    if (statuses.some((status) => status === 401 || status === 403)) {
      throw new ProviderError(
        "Akses ke penyedia API ditolak. Periksa RAPIDAPI_KEY dan pastikan sudah berlangganan endpoint Media Info dan Media Download.",
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
      "Media tidak ditemukan. Pastikan tautan benar, akun tidak privat, dan postingan masih tersedia.",
      404
    );
  }

  const username = info?.username ?? download?.username ?? target.username;
  const shortcode = info?.shortcode ?? target.shortcode;
  const aligned = info !== null && info.medias.length === base.length;
  const baseName = safeName(
    `${username || "instagram"}_${shortcode || "media"}`
  );

  const items: MediaItem[] = base.map((media, index) => {
    const twin = aligned ? info.medias[index] : null;
    const mediaUrl = media.url ?? twin?.url ?? null;
    const thumbUrl =
      media.type === "photo" ? mediaUrl : (media.thumb ?? twin?.thumb ?? null);

    const name = base.length > 1 ? `${baseName}_${index + 1}` : baseName;

    return {
      type: media.type,
      src: mediaUrl ? proxyPath(mediaUrl) : "",
      download: mediaUrl ? proxyPath(mediaUrl, { name, download: true }) : "",
      direct: media.type === "photo" ? mediaUrl : null,
      thumb: thumbUrl ? proxyPath(thumbUrl) : null,
      thumbDirect: thumbUrl,
    };
  });

  const usable = items.filter((item) => item.src);

  const mediaType: InstagramData["mediaType"] =
    usable.length > 1
      ? "carousel"
      : usable[0]?.type === "video"
        ? "video"
        : "photo";

  const kind: InstagramData["kind"] =
    target.kind === "reel"
      ? "Reel"
      : target.kind === "post"
        ? "Post"
        : mediaType === "video"
          ? "Reel"
          : "Post";

  const avatarUrl = info?.avatar ?? null;

  return {
    id: shortcode,
    kind,
    mediaType,
    url: target.url,
    profileUrl: username ? `https://www.instagram.com/${username}/` : null,
    author: {
      username: username ?? null,
      fullName: info?.fullName ?? download?.fullName ?? null,
      verified: info?.verified ?? false,
      avatar: avatarUrl ? proxyPath(avatarUrl) : null,
      avatarDirect: avatarUrl,
    },
    stats: {
      likes: info?.likes ?? download?.likes ?? null,
      comments: info?.comments ?? download?.comments ?? null,
      views: info?.views ?? download?.views ?? null,
    },
    timestamp: info?.timestamp ?? download?.timestamp ?? null,
    caption: longerText(info?.caption ?? null, download?.caption ?? null),
    items: usable,
    meta: { info: info !== null, download: download !== null },
  };
}
