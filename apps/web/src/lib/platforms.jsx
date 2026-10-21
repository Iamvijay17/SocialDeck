import { AtSign, Briefcase, Camera, Cloud, FlaskConical, MessageCircle, ThumbsUp, X as XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export const PLATFORM_STYLE = {
  bluesky: { label: 'Bluesky', color: '#0085ff', icon: Cloud },
  mastodon: { label: 'Mastodon', color: '#6364ff', icon: AtSign },
  instagram: { label: 'Instagram', color: '#e1306c', icon: Camera },
  facebook: { label: 'Facebook Pages', color: '#1877f2', icon: ThumbsUp },
  threads: { label: 'Threads', color: '#a1a1aa', icon: MessageCircle },
  linkedin: { label: 'LinkedIn', color: '#0a66c2', icon: Briefcase },
  x: { label: 'X', color: '#e4e4e7', icon: XIcon },
  mock: { label: 'Mock (dev only)', color: '#f59e0b', icon: FlaskConical },
};

export function platformLabel(id) {
  return PLATFORM_STYLE[id]?.label ?? id;
}

export function PlatformIcon({ platform, className, size = 'md' }) {
  const s = PLATFORM_STYLE[platform] ?? { color: '#71717a', icon: Cloud };
  const Icon = s.icon;
  const dims = size === 'sm' ? 'size-6' : size === 'lg' ? 'size-10' : 'size-8';
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-lg', dims, className)}
      style={{ backgroundColor: `${s.color}22`, color: s.color }}
      title={s.label}
      aria-hidden="true"
    >
      <Icon className={size === 'sm' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4'} />
    </span>
  );
}
