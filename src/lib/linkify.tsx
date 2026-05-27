import type { ReactNode } from 'react'

const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi
const TRAILING_PUNCTUATION = /[),.!?，。！？；：、】【】》」』]+$/u

function normalizeHref(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

function splitTrailingPunctuation(value: string) {
  const match = value.match(TRAILING_PUNCTUATION)
  if (!match) {
    return {
      url: value,
      trailing: '',
    }
  }
  return {
    url: value.slice(0, -match[0].length),
    trailing: match[0],
  }
}

export function renderTextWithLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0]
    const matchIndex = match.index ?? 0
    const { url, trailing } = splitTrailingPunctuation(raw)

    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex))
    }

    nodes.push(
      <a
        key={`${matchIndex}-${url}`}
        href={normalizeHref(url)}
        target="_blank"
        rel="noreferrer"
        className="break-all text-blue-600 underline underline-offset-2 transition hover:text-blue-500 dark:text-blue-300 dark:hover:text-blue-200"
      >
        {url}
      </a>,
    )

    if (trailing) {
      nodes.push(trailing)
    }

    lastIndex = matchIndex + raw.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes.length > 0 ? nodes : [text]
}
