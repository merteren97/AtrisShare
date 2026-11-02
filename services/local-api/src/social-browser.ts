import { spawn } from "node:child_process";

/** Separate allowlist: the existing YouTube browser helper intentionally accepts Google only. */
export function isSocialAuthorizationUrl(raw: string): boolean {
  try {
    if (raw.length > 16384 || /[\s"'\\]/.test(raw)) return false;
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
    const provider = url.hostname === "x.com" && url.pathname === "/i/oauth2/authorize" ? "x"
      : url.hostname === "www.linkedin.com" && url.pathname === "/oauth/native-pkce/authorization" ? "linkedin"
      : url.hostname === "www.tiktok.com" && url.pathname === "/v2/auth/authorize/" ? "tiktok" : null;
    if (!provider) return false;
    const clientField = provider === "tiktok" ? "client_key" : "client_id";
    const fields = [clientField, "response_type", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"];
    if ([...url.searchParams.keys()].some(key => !fields.includes(key)) || fields.some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key))) return false;
    if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get("state")!) ||
      !(provider === "tiktok" ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{43}$/).test(url.searchParams.get("code_challenge")!)) return false;
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    return redirect.protocol === "http:" && redirect.hostname === "127.0.0.1" && !!redirect.port && !redirect.username && !redirect.password &&
      !redirect.search && !redirect.hash && redirect.pathname === `/oauth/social/${provider}/callback`;
  } catch { return false; }
}
/** Service-generated URLs only; no shell, detached processes, credential logging or arbitrary executable configuration. */
export async function openSocialAuthorizationBrowser(url: string): Promise<boolean> {
  if (!isSocialAuthorizationUrl(url)) return false;
  const [command, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
    : process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
  return new Promise(resolve => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: "ignore", shell: false });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 8000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0); });
  });
}
