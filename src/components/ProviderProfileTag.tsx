import type { AppSettings } from '../types'

const PROVIDER_TAG_STYLE_MAP = {
  rose: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/20',
  orange: 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-400/20',
  amber: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/20',
  lime: 'bg-lime-500/15 text-lime-300 ring-1 ring-lime-400/20',
  emerald: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/20',
  cyan: 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/20',
  sky: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/20',
  blue: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/20',
  violet: 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20',
  fuchsia: 'bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-400/20',
} as const

type ProviderTagColor = keyof typeof PROVIDER_TAG_STYLE_MAP
const PROVIDER_TAG_STYLES = Object.values(PROVIDER_TAG_STYLE_MAP)

function hashProviderKey(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

export function getProviderProfileTagClass(colorKey: string, tagColor?: string | null) {
  if (tagColor && tagColor in PROVIDER_TAG_STYLE_MAP) {
    return PROVIDER_TAG_STYLE_MAP[tagColor as ProviderTagColor]
  }
  return PROVIDER_TAG_STYLES[hashProviderKey(colorKey) % PROVIDER_TAG_STYLES.length] ?? PROVIDER_TAG_STYLES[0]
}

export function formatProviderProfileTagText(input: {
  name: string
  apiMode?: AppSettings['apiMode'] | null
  isDefault?: boolean
  includeMode?: boolean
  includeDefault?: boolean
}) {
  const parts: string[] = []
  if (input.includeDefault !== false && input.isDefault) {
    parts.push('默认')
  }
  if (input.includeMode !== false && input.apiMode) {
    parts.push(input.apiMode === 'videos' ? '视频' : '图片')
  }
  parts.push(input.name)
  return parts.join(' · ')
}

export default function ProviderProfileTag(props: {
  name: string
  colorKey: string
  tagColor?: string | null
  apiMode?: AppSettings['apiMode'] | null
  isDefault?: boolean
  includeMode?: boolean
  includeDefault?: boolean
  text?: string
  className?: string
}) {
  const text = props.text ?? formatProviderProfileTagText(props)
  return (
    <span
      title={text}
      className={`inline-flex min-w-0 max-w-full items-center rounded-full px-2.5 py-1 text-xs font-medium leading-4 ${getProviderProfileTagClass(props.colorKey, props.tagColor)} ${props.className ?? ''}`}
    >
      <span className="block max-w-full truncate">{text}</span>
    </span>
  )
}
