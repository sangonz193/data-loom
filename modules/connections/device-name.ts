export const DEVICE_NAME_MAX_LENGTH = 64

export function deviceNameFromUserAgent(userAgent: string) {
  const browser =
    /Edg(?:e|A|iOS)?\//.test(userAgent) ? "Edge"
    : /Firefox\/|FxiOS\//.test(userAgent) ? "Firefox"
    : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : ""
  const os =
    /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
    : /Android/.test(userAgent) ? "Android"
    : /CrOS/.test(userAgent) ? "ChromeOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /Macintosh/.test(userAgent) ? "macOS"
    : /Linux/.test(userAgent) ? "Linux"
    : ""
  return browser && os ? `${browser} on ${os}` : browser || os || "Browser"
}
