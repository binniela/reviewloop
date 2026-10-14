import type { Property } from "../properties.js";

/** A review platform we can read from and reply on. Phase 1: Google. */
export interface ReviewSource {
  readonly name: string;
  /** Whether this property is set up for this source (e.g. has a Google location). */
  supports(property: Property): boolean;
  fetchReviews(property: Property): Promise<SourceReview[]>;
  /** Platform-wide totals from the most recent fetch, for the metrics page. */
  summary(property: Property): { count: number; average: number | null } | null;
  postReply(property: Property, externalId: string, text: string): Promise<void>;
}

export interface SourceReview {
  externalId: string;
  author: string | null;
  rating: number | null;
  body: string | null;
  reviewedAt: string; // ISO
  existingReply: string | null;
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

interface GoogleReview {
  reviewId: string;
  name: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string };
}

/**
 * Google Business Profile reviews (My Business API v4: accounts.locations.reviews).
 * Needs an OAuth client with the business.manage scope and a refresh token from an account
 * that owns or manages each location. properties.google_location = "accounts/{a}/locations/{l}".
 */
export class GoogleBusinessProfile implements ReviewSource {
  readonly name = "google";
  private token: { value: string; expires: number } | null = null;
  private totals = new Map<string, { count: number; average: number | null }>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly maxPages = 5,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) throw new Error(`Google OAuth: ${json.error ?? res.status}`);
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  supports(property: Property) {
    return !!property.google_location;
  }

  async fetchReviews(property: Property): Promise<SourceReview[]> {
    if (!property.google_location) throw new Error(`${property.id} has no google_location`);
    const out: SourceReview[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const url = new URL(`https://mybusiness.googleapis.com/v4/${property.google_location}/reviews`);
      url.searchParams.set("pageSize", "50");
      url.searchParams.set("orderBy", "updateTime desc");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(15_000) });
      const json = (await res.json()) as {
        reviews?: GoogleReview[];
        nextPageToken?: string;
        totalReviewCount?: number;
        averageRating?: number;
        error?: { message: string };
      };
      if (!res.ok) throw new Error(`Google reviews ${res.status}: ${json.error?.message ?? ""}`);
      if (page === 0 && json.totalReviewCount !== undefined) {
        this.totals.set(property.id, { count: json.totalReviewCount, average: json.averageRating ?? null });
      }
      for (const r of json.reviews ?? []) {
        out.push({
          externalId: r.name, // full resource name, used directly when replying
          author: r.reviewer?.isAnonymous ? null : (r.reviewer?.displayName ?? null),
          rating: r.starRating ? (STARS[r.starRating] ?? null) : null,
          body: r.comment ?? null,
          reviewedAt: r.createTime,
          existingReply: r.reviewReply?.comment ?? null,
        });
      }
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  summary(property: Property) {
    return this.totals.get(property.id) ?? null;
  }

  async postReply(_property: Property, externalId: string, text: string): Promise<void> {
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${externalId}/reply`, {
      method: "PUT",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment: text }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { message: string } };
      throw new Error(`Google reply ${res.status}: ${json.error?.message ?? ""}`);
    }
  }
}

/** In-memory source for development, demos, and tests. */
export class MockReviewSource implements ReviewSource {
  readonly name = "google";
  replies: { externalId: string; text: string }[] = [];
  failNextPost: string | null = null;
  constructor(public reviews: Record<string, SourceReview[]> = {}) {}

  supports() {
    return true;
  }

  async fetchReviews(property: Property) {
    return (this.reviews[property.id] ?? []).map((r) => ({ ...r }));
  }

  /** Mock totals: a starting baseline plus whatever reviews have been added. */
  baseline: Record<string, { count: number; sum: number }> = {};

  summary(property: Property) {
    const base = this.baseline[property.id] ?? { count: 0, sum: 0 };
    const rated = (this.reviews[property.id] ?? []).filter((r) => r.rating !== null);
    const count = base.count + rated.length;
    const sum = base.sum + rated.reduce((a, r) => a + r.rating!, 0);
    return { count, average: count ? Math.round((sum / count) * 100) / 100 : null };
  }

  async postReply(property: Property, externalId: string, text: string) {
    if (this.failNextPost) {
      const msg = this.failNextPost;
      this.failNextPost = null;
      throw new Error(msg);
    }
    this.replies.push({ externalId, text });
    const r = this.reviews[property.id]?.find((x) => x.externalId === externalId);
    if (r) r.existingReply = text;
  }
}

export function reviewSourceFromEnv(env = process.env): ReviewSource {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    return new GoogleBusinessProfile(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN);
  }
  return new MockReviewSource();
}
