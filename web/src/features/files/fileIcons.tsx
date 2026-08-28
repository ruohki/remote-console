import { File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet, FileText, FileType, FileVideo, Folder, HardDrive, Home, type LucideProps } from 'lucide-react'
import { cx } from '@/components/cx'

type Kind = 'folder' | 'root' | 'home' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'code' | 'sheet' | 'json' | 'font' | 'file'

const EXT: Record<string, Kind> = {}
const add = (kind: Kind, exts: string) => exts.split(' ').forEach((e) => (EXT[e] = kind))
add('image', 'png jpg jpeg gif webp bmp svg heic heif avif tiff tif ico psd')
add('video', 'mp4 m4v mkv mov avi webm wmv flv mpg mpeg')
add('audio', 'mp3 m4a aac ogg opus flac wav aiff wma')
add('archive', 'zip gz tgz bz2 xz zst 7z rar tar lz4 dmg iso pkg msi deb rpm apk jar')
add('text', 'txt md rtf log doc docx odt pdf pages epub csv')
add('sheet', 'xls xlsx ods numbers')
add('json', 'json jsonl yaml yml toml')
add('code', 'js ts tsx jsx mjs cjs py rs go java kt swift c h cpp hpp cs rb php sh ps1 bat html css scss sql')
add('font', 'ttf otf woff woff2')

const ICON: Record<Kind, { C: (p: LucideProps) => React.ReactNode; tone: string }> = {
  folder: { C: Folder, tone: 'text-[#6cb6ff]' },
  root: { C: HardDrive, tone: 'text-[#9aa3b2]' },
  home: { C: Home, tone: 'text-[#9aa3b2]' },
  image: { C: FileImage, tone: 'text-[#c084fc]' },
  video: { C: FileVideo, tone: 'text-[#f472b6]' },
  audio: { C: FileAudio, tone: 'text-[#34d399]' },
  archive: { C: FileArchive, tone: 'text-[#f5b942]' },
  text: { C: FileText, tone: 'text-[#9aa3b2]' },
  code: { C: FileCode, tone: 'text-[#7dd3fc]' },
  sheet: { C: FileSpreadsheet, tone: 'text-[#34d399]' },
  json: { C: FileJson, tone: 'text-[#f5b942]' },
  font: { C: FileType, tone: 'text-[#9aa3b2]' },
  file: { C: FileIcon, tone: 'text-[#9aa3b2]' },
}

export function fileKind(name: string, isDir: boolean): Kind {
  if (isDir) return 'folder'
  const i = name.lastIndexOf('.')
  if (i <= 0) return 'file'
  return EXT[name.slice(i + 1).toLowerCase()] ?? 'file'
}

/** Icon for a device entry, tinted by type. Roots (home, volumes) get their own glyphs. */
export function FileTypeIcon({ name, isDir, root, size = 14, className }: { name: string; isDir: boolean; root?: 'home' | 'root'; size?: number; className?: string }) {
  const kind: Kind = root ?? fileKind(name, isDir)
  const { C, tone } = ICON[kind]
  return <C size={size} className={cx('shrink-0', tone, className)} aria-hidden />
}
