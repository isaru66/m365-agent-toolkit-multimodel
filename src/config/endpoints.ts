export function providerBaseUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS inference base URL`);
  }
  if (!/^https:\/\//i.test(value) || url.protocol !== "https:" ||
      url.username || url.password || url.search || url.hash ||
      /[\s\\?#]/.test(value)) {
    throw new Error(`${name} must use HTTPS without credentials, query, fragment, or whitespace`);
  }
  if (/\/api\/projects(?:\/|$)/i.test(url.pathname)) {
    throw new Error(`${name} is a Foundry project endpoint; use /anthropic or /openai/v1 on the resource instead`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if ((name === "ANTHROPIC_BASE_URL" && /\/v1(?:\/messages|\/models)?$/i.test(url.pathname)) ||
      (name === "GEMINI_BASE_URL" && /\/v1(?:beta|alpha)?(?:\/models)?$/i.test(url.pathname)) ||
      (name === "AZURE_OPENAI_BASE_URL" && /\/(?:chat\/completions|responses)$/i.test(url.pathname))) {
    throw new Error(`${name} must be a base URL, not an API version or operation appended by the client`);
  }
  return url.href.replace(/\/$/, "");
}
