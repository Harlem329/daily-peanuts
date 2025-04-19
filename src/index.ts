export interface Env {
  GOCOMICS_SLUG: string;
  WEBHOOK_ID: string;
  WEBHOOK_TOKEN: string;
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

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const now = new Date(event.scheduledTime);
    const { cron } = event;

    if (cron === "0 15 * * *" && isDstObserved(now)) return;
    if (cron === "0 14 * * *" && !isDstObserved(now)) return;

    const formatted = [
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      now.getUTCDate(),
    ]
      .map(String)
      .join("/");

    console.log(`Fetching comic for ${formatted}`);

    const url = new URL("https://web.scraper.workers.dev");
    url.searchParams.set(
      "url",
      `https://www.gocomics.com/${env.GOCOMICS_SLUG}/${formatted}`,
    );
    const selector = `div[data-sentry-component="ComicViewer"] script[type="application/ld+json"][data-sentry-component="Schema"]`;
    url.searchParams.set("selector", selector);
    url.searchParams.set("scrape", "text");

    const response = await fetch(url);
    if (!response.ok) {
      console.error("Scraper failed:", response.status);
      throw new Error(`Scraper error: ${response.status}`);
    }

    const data = (await response.json()) as {
      result: Record<string, string[]>;
    };

    if (!data.result || !data.result[selector]?.length) {
      console.error("No data found for selector:", selector);
      throw new Error(
        `No data found for ${env.GOCOMICS_SLUG} on ${formatted}`,
      );
    }

    let strip: ComicPagePayload | undefined;
    let image: Blob | undefined;

    for (const raw of data.result[selector]) {
      try {
        const parsed = JSON.parse(raw) as ComicPagePayload;
        if (parsed.representativeOfPage && parsed.contentUrl) {
          console.log("Found content URL:", parsed.contentUrl);
          const res = await fetch(parsed.contentUrl, { method: "GET" });
          if (
            res.ok &&
            res.headers.get("Content-Type")?.startsWith("image/")
          ) {
            strip = parsed;
            image = await res.blob();
            break;
          }
        }
      } catch {
        console.warn("Failed to parse one script block");
      }
    }

    if (!strip || !image) {
      throw new Error(
        `No usable comic image found on ${env.GOCOMICS_SLUG}/${formatted}`,
      );
    }

    const form = new FormData();
    form.set(
      "payload_json",
      JSON.stringify({
        content: `[${strip.name}](<https://www.gocomics.com/${env.GOCOMICS_SLUG}/${formatted}>)`,
        attachments: [{ id: 0 }],
        allowed_mentions: { parse: [] },
      }),
    );
    form.set("files[0]", image, `${formatted.replace(/\//g, "-")}.png`);

    const discordResponse = await fetch(
      `https://discord.com/api/v10/webhooks/${env.WEBHOOK_ID}/${env.WEBHOOK_TOKEN}`,
      {
        method: "POST",
        body: form,
      },
    );

    console.log("Posted to Discord:", discordResponse.status);
  },
};
