import Link from "next/link"

import { GitHubIcon } from "./github-icon"

export function Footer() {
  return (
    <footer className="flex flex-row items-center px-4 py-4">
      <Link
        href="https://github.com/sangonz193/data-loom"
        rel="noopener noreferrer"
        target="_blank"
        className="ml-auto flex p-1"
        title="View on GitHub"
      >
        <span className="sr-only">View on GitHub</span>
        <GitHubIcon className="size-7" />
      </Link>
    </footer>
  )
}
