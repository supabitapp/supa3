export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__supacode/channel") {
      const channel = url.searchParams.get("channel") === "nightly" ? "nightly" : "latest";
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `supacode_web_channel=${channel}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }

    const nightly = request.headers
      .get("Cookie")
      ?.split(";")
      .some((cookie) => cookie.trim() === "supacode_web_channel=nightly");
    url.hostname = nightly ? "nightly.app.next.supacode.sh" : "latest.app.next.supacode.sh";
    url.protocol = "https:";
    url.port = "";
    const upstream = await fetch(new Request(url, request), { redirect: "manual" });
    const response = new Response(upstream.body, upstream);
    response.headers.append("Vary", "Cookie");
    response.headers.set("Cache-Control", "private, no-cache");
    return response;
  },
};
