import React from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, Link } from 'react-router-dom'
import { NAV_ITEMS } from './navigation'
import './Breadcrumb.css'

/** Root of the in-app hierarchy. `/` is the public landing page, not this. */
const HOME_PATH = '/dashboard'

/**
 * Segments that exist only as URL structure and have no page of their own.
 * They render as plain text rather than a link that would 404.
 */
const NON_NAVIGABLE_PREFIXES = new Set(['/tasks'])

/**
 * Breadcrumb trail derived from the current pathname.
 *
 * Labels come from the shared nav config where a segment corresponds to a real
 * nav destination, so a rename in one place moves the sidebar and the trail
 * together.
 */
const Breadcrumb: React.FC = () => {
  const { t } = useTranslation()
  const location = useLocation()
  const segments = location.pathname.split('/').filter(Boolean)

  const labelFor = (fullPath: string, segment: string, index: number): string => {
    const navItem = NAV_ITEMS.find((item) => item.path === fullPath)
    if (navItem) return t(navItem.labelKey)

    if (fullPath === '/tasks') return t('nav.tasks')
    // `/tasks/<id>` — a detail page, named by the id it is showing.
    if (index === 1 && segments[0] === 'tasks') {
      return t('nav.taskWithId', { id: segment })
    }
    return segment.charAt(0).toUpperCase() + segment.slice(1)
  }

  // Nothing above the root to show a trail for.
  if (segments.length === 0) return null
  const isAtHome = location.pathname === HOME_PATH
  if (isAtHome) return null

  return (
    <nav className="breadcrumb" aria-label={t('a11y.breadcrumb')}>
      <ol>
        <li>
          <Link to={HOME_PATH}>{t('nav.dashboard')}</Link>
        </li>
        {segments.map((segment, index) => {
          const fullPath = '/' + segments.slice(0, index + 1).join('/')
          const isLast = index === segments.length - 1
          const label = labelFor(fullPath, segment, index)
          const isNavigable = !isLast && !NON_NAVIGABLE_PREFIXES.has(fullPath)

          return (
            <li key={fullPath}>
              <span className="separator" aria-hidden="true">
                /
              </span>
              {isNavigable ? (
                <Link to={fullPath}>{label}</Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{label}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default Breadcrumb
