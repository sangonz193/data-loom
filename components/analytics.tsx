"use client"

import { Analytics as VercelAnalytics } from "@vercel/analytics/react"

export function redactAnalyticsFragment<T extends { url: string }>(event: T) {
  return { ...event, url: event.url.split("#", 1)[0]! }
}

export function Analytics() {
  return <VercelAnalytics beforeSend={redactAnalyticsFragment} />
}
