import { LayoutDashboard, PlusCircle, Bot, Wallet, History } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Single source of truth for in-app navigation.
 *
 * The sidebar, the mobile drawer, and the breadcrumb trail all read from here.
 * They used to each carry their own list — which is how the drawer ended up
 * with hardcoded English labels while the sidebar was translated, and how the
 * sidebar's "Dashboard" ended up pointing at `/` (the public landing page)
 * instead of `/dashboard`. One list, one set of labels, one set of paths.
 */
export interface NavItem {
  /** Route this item navigates to. */
  path: string
  /** i18n key for the visible label. */
  labelKey: string
  icon: LucideIcon
}

export interface NavGroup {
  /** Stable key, used for React keys and CSS hooks. */
  id: string
  /** i18n key for the group heading. */
  labelKey: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    labelKey: 'nav.group.overview',
    items: [{ path: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard }],
  },
  {
    id: 'work',
    labelKey: 'nav.group.work',
    items: [
      { path: '/tasks/new', labelKey: 'nav.newTask', icon: PlusCircle },
      { path: '/tasks/history', labelKey: 'nav.taskHistory', icon: History },
      { path: '/agents', labelKey: 'nav.agents', icon: Bot },
    ],
  },
  {
    id: 'account',
    labelKey: 'nav.group.account',
    items: [{ path: '/wallet', labelKey: 'nav.wallet', icon: Wallet }],
  },
]

/** Flat list of every navigable item, in sidebar order. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

/**
 * Whether `currentPath` should light up `itemPath`.
 *
 * Exact match, or a descendant of it — so `/tasks/new/step-2` still highlights
 * "New Task", while `/tasks/123` (a task detail, which has no nav entry of its
 * own) correctly highlights neither `/tasks/new` nor `/tasks/history`.
 */
export function isNavItemActive(currentPath: string, itemPath: string): boolean {
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`)
}
