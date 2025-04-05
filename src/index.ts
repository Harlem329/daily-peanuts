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

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // This simply runs at the time your Cloudflare cron says (in UTC).
    // No DST checks. Just do everything once a day at your chosen time.

    const now = new Date(event.scheduledTime);
    const formatted = [
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      now.getUTCDate(),
    ]
      .map(String)
      .join("/");

    console.log(`Checking for today's ${env.GOCOMICS_SLUG} comic... (UK user)`);
    console.log(`Date path: ${formatted}`);

    // Build the scraping URL
    const url = new URL("https://web.scraper.workers.dev");
    url.searchParams.set(
      "url",
      `https://www.gocomics.com/${env.GOCOMICS_SLUG}/${formatted}`,
    );
    const selector =
      `div[data-sentry-component="ComicViewer"] ` +
      `script[type="application/ld+json"][data-sentry-component="Schema"]`;
    url.searchParams.set("selector", selector);
    url.searchParams.set("scrape", "text");

    const response = await fetch(url);
    if (!response.ok) {
      throw Error(`Bad response from scraper: ${response.status}`);
    }

    const data = (await response.json()) as {
      result: Record<string, string[]>;
    };
    console.log("Scraper Result:", data.result);

    if (!data.result || !data.result[selector]?.length) {
      throw Error(`No suitable data found on page (${formatted})`);
    }

    let strip: ComicPagePayload | undefined;
    let image: Blob | undefined;

    for (const raw of data.result[selector]) {
      let parsed: ComicPagePayload;
      try {
        parsed = JSON.parse(raw) as ComicPagePayload;
      } catch {
        console.log("Failed to parse JSON:", raw);
        continue;
      }
      console.log("Parsed JSON-LD:", parsed);

      // We only want the "representativeOfPage" with a valid image
      if (parsed.representativeOfPage && parsed.contentUrl) {
        // Optional: Check that parsed.datePublished matches today's date
        // This helps ensure we don't post "yesterday's" comic if the site is stale.
        const [yearStr, monthStr, dayStr] = formatted.split("/");
        const pubDate = new Date(parsed.datePublished);

        if (
          pubDate.getUTCFullYear() !== parseInt(yearStr, 10) ||
          pubDate.getUTCMonth() + 1 !== parseInt(monthStr, 10) ||
          pubDate.getUTCDate() !== parseInt(dayStr, 10)
        ) {
          console.log(
            `Skipping: datePublished=${parsed.datePublished} does not match ${formatted}`,
          );
          continue;
        }

        const imageResponse = await fetch(parsed.contentUrl);
        if (
          imageResponse.ok &&
          imageResponse.headers.get("Content-Type")?.startsWith("image/")
        ) {
          strip = parsed;
          image = await imageResponse.blob();
          break;
        }
      }
    }

    if (!strip || !image) {
      throw Error(`No suitable "today" comic found for ${formatted}`);
    }

    // Now post to Discord
    console.log("Posting to Discord...");
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

    if (!discordResponse.ok) {
      const errorText = await discordResponse.text().catch(() => "");
      throw new Error(
        `Discord webhook failed (${discordResponse.status}): ${errorText}`,
      );
    }

    console.log("Success! Posted today's comic to Discord.");
  },
};
