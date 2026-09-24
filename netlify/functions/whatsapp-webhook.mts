import type { Config } from "@netlify/functions";

export default async (req: Request) => {
  const url = new URL(req.url);
  const verifyToken = Netlify.env.get("META_VERIFY_TOKEN") ?? "";

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200 });
    }

    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      console.log("WhatsApp webhook:", JSON.stringify(body));
    } catch {
      // Meta may retry malformed/non-JSON requests; acknowledge safely.
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
};
