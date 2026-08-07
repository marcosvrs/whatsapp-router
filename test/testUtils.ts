// The @opencode-ai/sdk client calls fetch(request: Request) — a single Request
// object — while our own WahaClient code calls fetch(url, init) with a plain
// string. Tests stub one global fetch shared by both call styles, so mock
// implementations need to normalize either shape to a URL string.
export function requestUrl(input: unknown): string {
  return typeof input === "string" ? input : (input as Request).url;
}
