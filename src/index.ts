export interface Env {
  GOCOMICS_SLUG: string;
  WEBHOOK_ID: string;
  WEBHOOK_TOKEN: string;
  DEBUG?: string;
}

interface ComicPagePayload {
  "@context": "https://schema.org";
  "@type": "ImageObject" | "ComicSeries";
  isAccessibleForFree?: boolean;
  genre?: string;
  inLanguage?: string;
  publisher?: {
    "@type": string;
    name: string;
    url: string;
    logo: { "@type": string; url: string };
    sameAs: string[];
  };

  name: string;
  description: string;
  url: string;
  author: { "@type": string; name: string };
  contentUrl: string;
  creator: {
    "@type": string;
    name: string;
    url: string;
  };
  datePublished: string;
  representativeOfPage: boolean;
}

const stdTimezoneOffset = (date: Date) => {
  const jan = new Date(date.getFullYear(), 0, 1);
  const jul = new Date(date.getFullYear(), 6, 1);
  return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
};

const convertTZ = (date: Date, tzString: string) =>
  new Date(date.toLocaleString("en-US", { timeZone: tzString }));

const isDstObserved = (date: Date) => {
  const today = convertTZ(date, "America/New_York");
  return today.getTimezoneOffset() < stdTimezoneOffset(today);
};

const debugLog = (env: Env, ...args: any[]) => {
  if (env.DEBUG === "true") {
    console.log(...args);
  }
};

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const now = new Date(event.scheduledTime);
    const { cron } = event;

    if (cron === "0 15 * * *" && isDstObserved(now)) {
      debugLog(env, "Skipping due to DST mismatch (EDT)");
      return;
    } else if (cron === "0 14 * * *" && !isDstObserved(now)) {
      debugLog(env, "Skipping due to DST mismatch (EST)");
      return;
    }

    debugLog(env, `Checking for today's ${env.GOCOMICS_SLUG} comic...`);

    const formatted = [
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      now.getUTCDate(),
    ]
      .map(String)
      .join("/");

    const url = new URL("https://web.scraper.workers.dev");
    url.searchParams.set(
      "url",
      `https://www.gocomics.com/${env.GOCOMICS_SLUG}/${formatted}`,
    );
    const selector = `div[data-sentry-component="ComicViewer"] script[type="application/ld+json"][data-sentry-component="Schema"]`;
    url.searchParams.set("selector", selector);
    url.searchParams.set("scrape", "text");

    debugLog(env, "Scraping URL:", url.toString());
    debugLog(env, "Using selector:", selector);

    const response = await fetch(url);
    if (!response.ok) {
      throw Error(`Bad response from scraper: ${response.status}`);
    }

    const rawText = await response.text();
    debugLog(env, "Raw scraper response:", rawText.slice(0, 500)); // trim long logs

    let data: { result: Record<string, string[]> };
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error("Failed to parse JSON from scraper:", e);
      throw Error("Invalid JSON from scraper");
    }

    if (!data.result || !data.result[selector]?.length) {
      console.error("No matching selector data found. Available keys:", Object.keys(data.result));
      throw Error(
        `No suitable data found on ${env.GOCOMICS_SLUG} page (${formatted})`,
      );
    }

    debugLog(env, "Number of matching data entries:", data.result[selector].length);

    let strip: ComicPagePayload | undefined;
    let image: Blob | undefined;

    for (const raw of data.result[selector]) {
      let parsed: ComicPagePayload;
      try {
        parsed = JSON.parse(raw);
      } catch {
        debugLog(env, "Failed to parse script block as JSON:", raw.slice(0, 200));
        continue;
      }

      debugLog(env, "[Parsed]", parsed);

      if (parsed.representativeOfPage && parsed.contentUrl) {
        debugLog(env, "Found good payload with content URL:", parsed.contentUrl);
        const imageRes = await fetch(parsed.contentUrl, { method: "GET" });

        const type = imageRes.headers.get("Content-Type") || "unknown";
        debugLog(env, "Content-Type:", type);

        if (imageRes.ok && type.startsWith("image/")) {
          strip = parsed;
          image = await imageRes.blob();
          break;
        } else {
          debugLog(env, "Invalid image or content type, skipping");
        }
      }
    }

    if (!strip || !image) {
      throw Error(
        `No suitable data found on ${env.GOCOMICS_SLUG} page (${formatted}) after ${data.result[selector].length} script tags`,
      );
    }

    const comicUrl = `https://www.gocomics.com/${env.GOCOMICS_SLUG}/${formatted}`;
    const filename = `${formatted.replace(/\//g, "-")}.png`;

    debugLog(env, "Posting to Discord with:", {
      title: strip.name,
      comicUrl,
      filename,
    });

    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        content: `[${strip.name}](<${comicUrl}>)`,
        attachments: [{ id: 0 }],
        allowed_mentions: { parse: [] },
      }),
    );
    form.set("files[0]", image, filename);

    const discordResponse = await fetch(
      `https://discord.com/api/v10/webhooks/${env.WEBHOOK_ID}/${env.WEBHOOK_TOKEN}`,
      {
        method: "POST",
        body: form,
      },
    );

    debugLog(env, "Discord response status:", discordResponse.status);
    if (!discordResponse.ok) {
      const errorText = await discordResponse.text();
      console.error("Discord error response:", errorText);
    }
  },
};
